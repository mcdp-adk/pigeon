import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createExtensionRuntime,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  ModelRegistry,
  type ResourceLoader,
  type Skill,
  SessionManager
} from "@mariozechner/pi-coding-agent";

import { createPigeonSettingsManager, syncLogToSessionManager } from "./context.js";
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
  onEvent?: (event: AgentSessionEvent) => void | Promise<void>;
}

export interface AgentRunResult {
  stopReason: string;
  errorMessage?: string;
  reply: string;
}

export interface AgentRunner {
  run(input: TelegramRunInput, store: ChatStore): Promise<AgentRunResult>;
  abort(): void;
}

interface ActiveRunState {
  onEvent?: (event: AgentSessionEvent) => void | Promise<void>;
  pendingEventTasks: Set<Promise<void>>;
  eventHandlerError?: unknown;
  lastAssistant?: AssistantMessage;
}

interface RunnerRuntime {
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly chatDir: string;
  readonly chatWorkspaceDir: string;
  activeRun: ActiveRunState | null;
  abortRequested: boolean;
  setSystemPrompt(nextPrompt: string): void;
}

interface RunnerCacheEntry {
  runner: AgentRunner;
  isActive: () => boolean;
}

const MAX_RUNNER_CACHE_SIZE = 100;
const cachedRunners = new Map<string, RunnerCacheEntry>();

export function getRunnerCacheSizeForTests(): number {
  return cachedRunners.size;
}

export function clearRunnerCacheForTests(): void {
  cachedRunners.clear();
}

export function addSyntheticActiveRunnerForTests(chatId: string): { deactivate: () => void } {
  const state = { active: true };
  const syntheticRunner: AgentRunner = {
    async run(): Promise<AgentRunResult> {
      throw new Error("synthetic runner");
    },
    abort(): void {
      return;
    }
  };

  cachedRunners.set(String(chatId), {
    runner: syntheticRunner,
    isActive: () => state.active
  });

  return {
    deactivate: () => {
      state.active = false;
    }
  };
}

function trimRunnerCache(): void {
  while (cachedRunners.size > MAX_RUNNER_CACHE_SIZE) {
    let evicted = false;

    for (const [key, entry] of cachedRunners) {
      if (entry.isActive()) {
        continue;
      }

      cachedRunners.delete(key);
      evicted = true;
      break;
    }

    if (!evicted) {
      break;
    }
  }
}

export function getOrCreateRunner(settings: Settings, chatId: string, chatDir: string): AgentRunner {
  const cacheKey = String(chatId);
  const existing = cachedRunners.get(cacheKey);
  if (existing) {
    cachedRunners.delete(cacheKey);
    cachedRunners.set(cacheKey, existing);
    return existing.runner;
  }

  const cacheEntry = createRunner(settings, cacheKey, chatDir);
  cachedRunners.set(cacheKey, cacheEntry);
  trimRunnerCache();
  return cacheEntry.runner;
}

function createRunner(settings: Settings, chatId: string, chatDir: string): RunnerCacheEntry {
  let runtimePromise: Promise<RunnerRuntime> | undefined;
  let active = false;

  const ensureRuntime = async (): Promise<RunnerRuntime> => {
    if (runtimePromise) {
      return runtimePromise;
    }

    runtimePromise = createRuntime(settings, chatId, chatDir);
    return runtimePromise;
  };

  const runner: AgentRunner = {
    async run(input: TelegramRunInput, store: ChatStore): Promise<AgentRunResult> {
      if (String(input.chatId) !== chatId) {
        throw new Error(`Runner chat mismatch: expected ${chatId}, got ${input.chatId}`);
      }

      const runtime = await ensureRuntime();
      if (runtime.activeRun) {
        throw new Error(`Chat ${chatId} already has an active run`);
      }

      runtime.abortRequested = false;
      const runState: ActiveRunState = {
        onEvent: input.onEvent,
        pendingEventTasks: new Set<Promise<void>>()
      };
      active = true;
      runtime.activeRun = runState;

      try {
        await store.logMessage(chatId, {
          date: "",
          ts: input.ts,
          user: input.user ?? input.userName ?? "telegram-user",
          userName: input.userName,
          text: input.userText,
          attachments: [],
          isBot: false
        });

        syncLogToSessionManager(runtime.sessionManager, runtime.chatDir, input.ts);

        const reloadedContext = runtime.sessionManager.buildSessionContext();
        runtime.session.agent.replaceMessages(reloadedContext.messages);

        const memory = readMemory(runtime.chatDir);
        const skills = loadPigeonSkills(runtime.chatDir, runtime.chatWorkspaceDir);
        runtime.setSystemPrompt(
          buildSystemPrompt(settings, chatId, runtime.chatWorkspaceDir, memory, skills)
        );
        await runtime.session.reload();

        let promptError: unknown;
        try {
          await runtime.session.prompt(formatPrompt(input));
        } catch (error: unknown) {
          promptError = error;
        }

        if (runState.pendingEventTasks.size > 0) {
          await Promise.allSettled(Array.from(runState.pendingEventTasks));
        }
        if (runState.eventHandlerError !== undefined && promptError === undefined) {
          promptError = runState.eventHandlerError;
        }

        const lastAssistant = runState.lastAssistant ?? getLastAssistant(runtime.session.messages);
        const stopReason =
          lastAssistant?.stopReason ??
          (runtime.abortRequested ? "aborted" : "stop");
        const errorMessage =
          lastAssistant?.errorMessage ??
          (promptError instanceof Error ? promptError.message : undefined);
        const reply = collectAssistantText(lastAssistant);

        if (reply.trim() !== "") {
          await store.logBotResponse(chatId, reply, String(Date.now()));
        }

        if (promptError && stopReason !== "aborted" && stopReason !== "error") {
          throw promptError;
        }

        return {
          stopReason,
          errorMessage,
          reply
        };
      } finally {
        runtime.activeRun = null;
        runtime.abortRequested = false;
        active = false;
        trimRunnerCache();
      }
    },

    abort(): void {
      const pendingRuntime = runtimePromise;
      if (!pendingRuntime) {
        return;
      }

      void pendingRuntime.then((runtime) => {
        runtime.abortRequested = true;
        void runtime.session.abort();
      });
    }
  };

  return {
    runner,
    isActive: () => active
  };
}

async function createRuntime(settings: Settings, chatId: string, chatDir: string): Promise<RunnerRuntime> {
  mkdirSync(chatDir, { recursive: true });

  const sandboxConfig = parseSandboxArg(settings.sandbox);
  const baseExecutor = createExecutor(sandboxConfig);
  const chatWorkspaceDir = resolveChatWorkspaceDir(baseExecutor, chatDir);
  const scopedExecutor = createChatScopedExecutor(baseExecutor, chatWorkspaceDir);
  const tools = createPigeonTools(scopedExecutor);

  const contextFile = join(chatDir, "context.jsonl");
  const sessionManager = openChatSessionManager(contextFile, chatDir);
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
  let systemPrompt = buildSystemPrompt(
    settings,
    chatId,
    chatWorkspaceDir,
    readMemory(chatDir),
    loadPigeonSkills(chatDir, chatWorkspaceDir)
  );

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

  const { session } = await createAgentSession({
    cwd: chatWorkspaceDir,
    modelRegistry,
    model,
    thinkingLevel: "off",
    tools,
    resourceLoader,
    sessionManager,
    settingsManager
  });

  const runtime: RunnerRuntime = {
    session,
    sessionManager,
    chatDir,
    chatWorkspaceDir,
    activeRun: null,
    abortRequested: false,
    setSystemPrompt(nextPrompt: string): void {
      systemPrompt = nextPrompt;
    }
  };

  session.subscribe((event) => {
    const activeRun = runtime.activeRun;
    if (!activeRun) {
      return;
    }

    if (activeRun.onEvent) {
      let pendingTask: Promise<void>;
      pendingTask = Promise.resolve()
        .then(async () => {
          await activeRun.onEvent?.(event);
        })
        .catch((error: unknown) => {
          if (activeRun.eventHandlerError === undefined) {
            activeRun.eventHandlerError = error;
          }
        })
        .finally(() => {
          activeRun.pendingEventTasks.delete(pendingTask);
        });
      activeRun.pendingEventTasks.add(pendingTask);
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      activeRun.lastAssistant = event.message as AssistantMessage;
    }
  });

  return runtime;
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

function openChatSessionManager(contextFile: string, chatDir: string): SessionManager {
  if (existsSync(contextFile)) {
    return SessionManager.open(contextFile, chatDir);
  }

  const sessionManager = SessionManager.create(chatDir, chatDir);
  sessionManager.setSessionFile(contextFile);
  return sessionManager;
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
  const displayName = input.userName ?? "user";
  return `[${displayName}]: ${input.userText}`;
}

function collectAssistantText(message: AssistantMessage | undefined): string {
  if (!message) {
    return "";
  }

  return message.content
    .filter((part): part is { type: "text"; text: string } => {
      return part.type === "text";
    })
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

  if (parts.length === 0) {
    return "(no memory yet)";
  }

  return parts.join("\n\n");
}

function readTrimmedFile(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const content = readFileSync(path, "utf-8").trim();
    return content === "" ? undefined : content;
  } catch {
    return undefined;
  }
}

function loadPigeonSkills(chatDir: string, chatWorkspaceDir: string): Skill[] {
  const skillMap = new Map<string, Skill>();
  const workspaceDir = join(chatDir, "..");
  const workspaceSkillsDir = join(workspaceDir, "skills");
  const chatSkillsDir = join(chatDir, "skills");

  const toWorkspacePath = (hostPath: string): string => {
    if (!hostPath.startsWith(workspaceDir)) {
      return hostPath;
    }

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
  const availableSkills = skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)";

  return [
    "You are Pigeon, a Telegram coding assistant.",
    "Be concise and practical.",
    "",
    "## Context",
    "- Use `date` for current date/time.",
    "- You can use previous context from session history.",
    "- For older history, inspect `log.jsonl` in this chat workspace.",
    "",
    "## Workspace",
    `- Workspace root: ${workspacePath}`,
    `- Active chat id: ${chatId}`,
    `- Active chat dir: ${chatWorkspaceDir}`,
    `- Model preference: ${settings.ai.provider}/${settings.ai.model}`,
    "",
    "## Layout",
    `${workspacePath}/`,
    "├── MEMORY.md",
    "├── skills/",
    `└── ${basename(chatWorkspaceDir)}/`,
    "    ├── MEMORY.md",
    "    ├── log.jsonl",
    "    ├── context.jsonl",
    "    └── skills/",
    "",
    "## Skills",
    availableSkills,
    "",
    "## Memory",
    memory,
    "",
    "## Tools",
    "- read: read files",
    "- bash: run shell commands",
    "- edit: modify existing files",
    "- write: create or overwrite files"
  ].join("\n");
}
