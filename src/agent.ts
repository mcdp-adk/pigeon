import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher, Socks5ProxyAgent } from "undici";
import {
  AgentSession,
  convertToLlm,
  createExtensionRuntime,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  ModelRegistry,
  type ResourceLoader,
  type Skill,
  SessionManager
} from "@mariozechner/pi-coding-agent";

import { createPigeonSettingsManager, syncLogToSessionManager } from "./context.js";
import { logWarning } from "./log.js";
import { createExecutor, parseSandboxArg, type ExecOptions, type ExecResult, type Executor } from "./sandbox.js";
import type { Settings } from "./settings.js";
import type { ChatStore } from "./store.js";
import { createPigeonTools } from "./tools/index.js";

export interface TelegramRunInput {
  chatId: number;
  userText: string;
  ts: string;
  user?: string;
  userName?: string;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
}

export type AgentRunEvent =
  | { type: "tool_start"; toolName: string; label: string }
  | { type: "tool_end"; toolName: string; label: string; isError: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "compaction_start"; reason: "threshold" | "overflow" }
  | { type: "retry"; attempt: number; maxAttempts: number };

export interface AgentRunResult {
  stopReason: string;
  errorMessage?: string;
  reply: string;
}

export interface AgentRunner {
  run(input: TelegramRunInput, store: ChatStore): Promise<AgentRunResult>;
  abort(): void;
}

// Cache runners per chat — simple Map, no eviction needed (allowed_chats whitelist bounds the size)
const chatRunners = new Map<string, AgentRunner>();

const defaultAiDispatcher = getGlobalDispatcher();
let installedAiProxyKey: string | null = null;

function installAiProxyDispatcher(proxy: string): void {
  const trimmedProxy = proxy.trim();
  if (trimmedProxy === "") {
    if (installedAiProxyKey !== null) {
      setGlobalDispatcher(defaultAiDispatcher);
      installedAiProxyKey = null;
    }
    return;
  }

  if (installedAiProxyKey === trimmedProxy) {
    return;
  }

  const proxyUrl = new URL(trimmedProxy);
  const protocol = proxyUrl.protocol;

  if (protocol === "http:" || protocol === "https:") {
    setGlobalDispatcher(new ProxyAgent(trimmedProxy));
    installedAiProxyKey = trimmedProxy;
    return;
  }

  if (protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks:") {
    if (protocol === "socks5h:") {
      proxyUrl.protocol = "socks5:";
    }
    setGlobalDispatcher(new Socks5ProxyAgent(proxyUrl.toString()));
    installedAiProxyKey = trimmedProxy;
    return;
  }

  throw new Error(`Unsupported ai.proxy protocol: ${protocol}`);
}

// Exported for tests only
export function getRunnerCacheSizeForTests(): number {
  return chatRunners.size;
}

export function clearRunnerCacheForTests(): void {
  chatRunners.clear();
}

export function addSyntheticActiveRunnerForTests(chatId: string): { deactivate: () => void } {
  const syntheticRunner: AgentRunner = {
    async run(): Promise<AgentRunResult> {
      throw new Error("synthetic runner");
    },
    abort(): void {
      return;
    }
  };
  chatRunners.set(String(chatId), syntheticRunner);
  // deactivate is a no-op now (no isActive concept), but keep the API shape for tests
  return { deactivate: () => chatRunners.delete(String(chatId)) };
}

export function getOrCreateRunner(settings: Settings, chatId: string, chatDir: string): AgentRunner {
  const existing = chatRunners.get(chatId);
  if (existing) return existing;

  const runner = createRunner(settings, chatId, chatDir);
  chatRunners.set(chatId, runner);
  return runner;
}

function createRunner(settings: Settings, chatId: string, chatDir: string): AgentRunner {
  mkdirSync(chatDir, { recursive: true });
  installAiProxyDispatcher(settings.ai.proxy);

  const sandboxConfig = parseSandboxArg(settings.sandbox);
  const baseExecutor = createExecutor(sandboxConfig);
  const chatWorkspaceDir = resolveChatWorkspaceDir(baseExecutor, chatDir);
  const scopedExecutor = createChatScopedExecutor(baseExecutor, chatWorkspaceDir);
  const tools = createPigeonTools(scopedExecutor);

  const contextFile = join(chatDir, "context.jsonl");
  // mom pattern: always open, SessionManager handles missing file gracefully
  const sessionManager = SessionManager.open(contextFile, chatDir);
  const settingsManager = createPigeonSettingsManager(dirname(chatDir));

  const model = getModel(
    settings.ai.provider as Parameters<typeof getModel>[0],
    settings.ai.model as never
  );
  if (!model) {
    throw new Error(`Unsupported model: ${settings.ai.provider}/${settings.ai.model}`);
  }

  const modelRegistry = new ModelRegistry(
    createEnvOnlyAuthBackend() as unknown as ConstructorParameters<typeof ModelRegistry>[0]
  );

  // Build initial system prompt
  let systemPrompt = buildSystemPrompt(
    settings,
    chatId,
    chatWorkspaceDir,
    readMemory(chatDir),
    loadPigeonSkills(chatDir, chatWorkspaceDir)
  );

  // mom pattern: new Agent + new AgentSession (synchronous, ready immediately)
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "off",
      tools,
    },
    convertToLlm,
    getApiKey: async (provider: string) => {
      const key = getEnvApiKey(provider);
      if (!key) throw new Error(`No API key for provider: ${provider}`);
      return key;
    },
  });

  // Load existing messages from context.jsonl (for restart continuity)
  const loadedSession = sessionManager.buildSessionContext();
  if (loadedSession.messages.length > 0) {
    agent.replaceMessages(loadedSession.messages);
  }

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => undefined,
    reload: async () => undefined
  };

  const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: chatWorkspaceDir,
    modelRegistry,
    resourceLoader,
    baseToolsOverride,
  });

  // Per-run mutable state (mom pattern)
  const runState = {
    active: false,
    abortRequested: false,
    onEvent: undefined as TelegramRunInput["onEvent"],
    pendingEventTasks: new Set<Promise<void>>(),
    eventHandlerError: undefined as unknown,
    lastAssistant: undefined as AssistantMessage | undefined,
    overflowRecovery: undefined as { promise: Promise<void>; resolve: () => void } | undefined,
  };

  // Subscribe to agent events once (mom pattern)
  session.subscribe((event) => {
    if (!runState.active) return;

    // Emit tool progress events to caller
    if (event.type === "tool_execution_start") {
      const label = (event.args as { label?: string }).label ?? event.toolName;
      fireOnEvent(runState, { type: "tool_start", toolName: event.toolName, label });
    } else if (event.type === "tool_execution_end") {
      const label = event.toolName;
      fireOnEvent(runState, { type: "tool_end", toolName: event.toolName, label, isError: event.isError });
    } else if (event.type === "message_update") {
      const ame = event.assistantMessageEvent as AssistantMessageEvent;
      if (ame.type === "text_delta") {
        fireOnEvent(runState, { type: "text_delta", delta: ame.delta });
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      runState.lastAssistant = event.message as AssistantMessage;
      if (runState.overflowRecovery) {
        runState.overflowRecovery.resolve();
        runState.overflowRecovery = undefined;
      }
    } else if (event.type === "auto_compaction_start") {
      if (event.reason === "overflow" && !runState.overflowRecovery) {
        let resolve!: () => void;
        runState.overflowRecovery = {
          promise: new Promise<void>(r => { resolve = r; }),
          resolve,
        };
      }
      fireOnEvent(runState, { type: "compaction_start", reason: event.reason });
    } else if (event.type === "auto_compaction_end") {
      if (runState.overflowRecovery && !event.willRetry) {
        runState.overflowRecovery.resolve();
        runState.overflowRecovery = undefined;
      }
    } else if (event.type === "auto_retry_start") {
      fireOnEvent(runState, { type: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts });
    }
  });

  const runner: AgentRunner = {
    async run(input: TelegramRunInput, store: ChatStore): Promise<AgentRunResult> {
      if (String(input.chatId) !== chatId) {
        throw new Error(`Runner chat mismatch: expected ${chatId}, got ${input.chatId}`);
      }
      if (runState.active) {
        throw new Error(`Chat ${chatId} already has an active run`);
      }

      runState.active = true;
      runState.abortRequested = false;
      runState.onEvent = input.onEvent;
      runState.pendingEventTasks = new Set();
      runState.eventHandlerError = undefined;
      runState.lastAssistant = undefined;

      try {
        // 1. Log inbound message
        await store.logMessage(chatId, {
          date: "",
          ts: input.ts,
          user: input.user ?? input.userName ?? "telegram-user",
          userName: input.userName,
          text: input.userText,
          attachments: [],
          isBot: false
        });

        // 2. Sync log.jsonl → sessionManager (excluding current message)
        syncLogToSessionManager(sessionManager, chatDir, input.ts);

        // 3. Reload messages from context.jsonl (mom pattern)
        const reloadedSession = sessionManager.buildSessionContext();
        if (reloadedSession.messages.length > 0) {
          agent.replaceMessages(reloadedSession.messages);
        }

        // 4. Refresh system prompt with latest memory + skills (mom pattern)
        const memory = readMemory(chatDir);
        const skills = loadPigeonSkills(chatDir, chatWorkspaceDir);
        systemPrompt = buildSystemPrompt(settings, chatId, chatWorkspaceDir, memory, skills);
        session.agent.setSystemPrompt(systemPrompt);

        // 5. Prompt with timestamped user message (mom pattern)
        let promptError: unknown;
        try {
          await session.prompt(formatPrompt(input));
          // SDK processes agent_end asynchronously on its event queue after
          // session.prompt() returns. Yield a macrotask so the SDK's chained
          // microtasks (message_end → agent_end → _checkCompaction → emit
          // auto_compaction_start) complete before we check for overflow.
          await new Promise(resolve => setTimeout(resolve, 0));
          if (runState.overflowRecovery) {
            await runState.overflowRecovery.promise;
          }
        } catch (error: unknown) {
          promptError = error;
        }

        // 6. Wait for async event handlers to settle
        if (runState.pendingEventTasks.size > 0) {
          await Promise.allSettled(Array.from(runState.pendingEventTasks));
        }
        if (runState.eventHandlerError !== undefined && promptError === undefined) {
          promptError = runState.eventHandlerError;
        }

        // 7. Collect result
        const lastAssistant = runState.lastAssistant ?? getLastAssistant(session.messages);
        const stopReason =
          lastAssistant?.stopReason ??
          (runState.abortRequested ? "aborted" : "stop");
        const errorMessage =
          lastAssistant?.errorMessage ??
          (promptError instanceof Error ? promptError.message : undefined);
        const reply = collectAssistantText(lastAssistant);

        // 8. Log bot response
        if (reply.trim() !== "") {
          await store.logBotResponse(chatId, reply, String(Date.now()));
        }

        if (promptError && stopReason !== "aborted" && stopReason !== "error") {
          throw promptError;
        }

        return { stopReason, errorMessage, reply };
      } finally {
        runState.active = false;
        runState.abortRequested = false;
        runState.onEvent = undefined;
        runState.overflowRecovery = undefined;
      }
    },

    abort(): void {
      runState.abortRequested = true;
      void session.abort();
    }
  };

  return runner;
}

function fireOnEvent(
  runState: { onEvent: TelegramRunInput["onEvent"]; pendingEventTasks: Set<Promise<void>>; eventHandlerError: unknown },
  event: AgentRunEvent
): void {
  if (!runState.onEvent) return;
  let task: Promise<void>;
  task = Promise.resolve()
    .then(() => runState.onEvent!(event))
    .catch((err: unknown) => {
      if (runState.eventHandlerError === undefined) {
        runState.eventHandlerError = err;
      }
    })
    .finally(() => {
      runState.pendingEventTasks.delete(task);
    });
  runState.pendingEventTasks.add(task);
}

function createEnvOnlyAuthBackend() {
  let fallbackResolver: ((provider: string) => string | undefined) | undefined;

  return {
    setFallbackResolver(resolver: (provider: string) => string | undefined): void {
      fallbackResolver = resolver;
    },
    getOAuthProviders(): [] {
      return [];
    },
    get(_provider: string): undefined {
      return undefined;
    },
    hasAuth(provider: string): boolean {
      return getEnvApiKey(provider) !== undefined || fallbackResolver?.(provider) !== undefined;
    },
    async getApiKey(provider: string): Promise<string | undefined> {
      return getEnvApiKey(provider) ?? fallbackResolver?.(provider);
    }
  };
}

function resolveChatWorkspaceDir(baseExecutor: Executor, chatDir: string): string {
  const workspaceParent = baseExecutor.getWorkspacePath(dirname(chatDir));
  return join(workspaceParent, basename(chatDir));
}

function createChatScopedExecutor(baseExecutor: Executor, chatWorkspaceDir: string): Executor {
  return {
    exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      return baseExecutor.exec(`cd ${shellEscape(chatWorkspaceDir)} && ${command}`, options);
    },
    getWorkspacePath(hostPath: string): string {
      return baseExecutor.getWorkspacePath(hostPath);
    }
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatPrompt(input: TelegramRunInput): string {
  const displayName = input.userName ?? input.user ?? "user";
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const offsetSign = offset >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
  const offsetMins = pad(Math.abs(offset) % 60);
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
  return `[${timestamp}] [${displayName}]: ${input.userText}`;
}

function collectAssistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function getLastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i] as { role?: string };
    if (candidate.role === "assistant") {
      return messages[i] as AssistantMessage;
    }
  }
  return undefined;
}

function readMemory(chatDir: string): string {
  const workspaceMemoryPath = join(chatDir, "..", "MEMORY.md");
  const chatMemoryPath = join(chatDir, "MEMORY.md");
  const parts: string[] = [];

  const workspaceMemory = readTrimmedFile(workspaceMemoryPath);
  if (workspaceMemory) {
    parts.push(`### Workspace Memory\n${workspaceMemory}`);
  }

  const chatMemory = readTrimmedFile(chatMemoryPath);
  if (chatMemory) {
    parts.push(`### Chat Memory\n${chatMemory}`);
  }

  return parts.length === 0 ? "(no memory yet)" : parts.join("\n\n");
}

function readTrimmedFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content === "" ? undefined : content;
  } catch (err) {
    logWarning("Failed to read file", { path, error: String(err) });
    return undefined;
  }
}

function loadPigeonSkills(chatDir: string, chatWorkspaceDir: string): Skill[] {
  const skillMap = new Map<string, Skill>();
  const workspaceDir = join(chatDir, "..");
  const workspaceSkillsDir = join(workspaceDir, "skills");
  const chatSkillsDir = join(chatDir, "skills");

  const toWorkspacePath = (hostPath: string): string => {
    if (!hostPath.startsWith(workspaceDir)) return hostPath;
    return `${chatWorkspaceDir}/..${hostPath.slice(workspaceDir.length)}`;
  };

  for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
    skillMap.set(skill.name, {
      ...skill,
      filePath: toWorkspacePath(skill.filePath),
      baseDir: toWorkspacePath(skill.baseDir)
    });
  }

  for (const skill of loadSkillsFromDir({ dir: chatSkillsDir, source: "chat" }).skills) {
    skillMap.set(skill.name, {
      ...skill,
      filePath: toWorkspacePath(skill.filePath),
      baseDir: toWorkspacePath(skill.baseDir)
    });
  }

  return Array.from(skillMap.values());
}

function buildSystemPrompt(
  settings: Settings,
  chatId: string,
  chatWorkspaceDir: string,
  memory: string,
  skills: Skill[]
): string {
  const workspacePath = join(chatWorkspaceDir, "..");
  const chatDirName = basename(chatWorkspaceDir);
  const availableSkills = skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)";
  const chatPath = `${workspacePath}/${chatDirName}`;
  const isDocker = settings.sandbox.startsWith("docker:");
  const envDescription = isDocker
    ? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
    : `You are running directly on the host machine.
- Bash working directory: ${chatWorkspaceDir}
- Be careful with system modifications`;

  return `You are Pigeon, a Telegram assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Telegram Formatting (HTML)

All responses use Telegram HTML format (parse_mode: HTML).

Tag usage:
- <b>text</b>: titles, key terms (at most once per paragraph)
- <code>value</code>: commands, paths, config values, variable names
- <pre>block</pre>: multi-line code blocks, command output
- <pre><code class="language-xxx">block</code></pre>: syntax-highlighted code
- <blockquote>text</blockquote>: quoted content, supplementary notes

Forbidden: <i> <em> <u> <s> and any other tags.
Use \n for line breaks (not <br>). Use "- " or "• " for list items.
Keep responses under 4096 characters. For long output, summarize inline or offer to write to a file.

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all chats)
├── skills/                      # Global CLI tools you create
└── ${chatDirName}/              # This chat
    ├── MEMORY.md                # Chat-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Chat-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${chatPath}/skills/<name>/\` (chat-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${availableSkills}

## Events (Scheduled Tasks)
Schedule tasks that wake you up at a specific time or on a recurring basis. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as the harness sees the file. Use in scripts to signal external events.
\`\`\`json
{"type": "immediate", "chatId": "${chatId}", "text": "Check inbox and summarize new emails"}
\`\`\`

**One-shot** - Triggers once at a specific time, then auto-deletes.
\`\`\`json
{"type": "one-shot", "chatId": "${chatId}", "text": "Send weekly report", "at": "2026-04-14T09:00:00+08:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Persists until you delete the file.
\`\`\`json
{"type": "periodic", "chatId": "${chatId}", "text": "Check for new messages", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30

### Creating Events
\`\`\`bash
cat > ${workspacePath}/events/my-task-$(date +%s).json << 'EOF'
{"type": "one-shot", "chatId": "${chatId}", "text": "Your task here", "at": "2026-04-14T09:00:00+08:00"}
EOF
\`\`\`

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Cancel: \`rm ${workspacePath}/events/foo.json\`

### When an Event Triggers
You receive a message like:
\`[EVENT:my-task.json:one-shot:2026-04-14T09:00:00+08:00] Your task here\`
For periodic events with nothing to report, respond with just \`[SILENT]\` to avoid unnecessary messages.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Chat (${chatPath}/MEMORY.md): chat-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"alice"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits

Each tool requires a "label" parameter (shown to user).
`;
}
