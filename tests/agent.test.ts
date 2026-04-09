import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const setGlobalDispatcher = vi.fn();
  const getGlobalDispatcher = vi.fn(() => "default-dispatcher");
  const ProxyAgent = vi.fn(function ProxyAgent(this: Record<string, unknown>, proxy: string) {
    this.kind = "http";
    this.proxy = proxy;
  });
  const Socks5ProxyAgent = vi.fn(function Socks5ProxyAgent(this: Record<string, unknown>, proxy: string) {
    this.kind = "socks5";
    this.proxy = proxy;
  });
  const getModel = vi.fn();

  return {
    setGlobalDispatcher,
    getGlobalDispatcher,
    ProxyAgent,
    Socks5ProxyAgent,
    getModel,
    AgentSession: vi.fn(),
    Agent: vi.fn(),
  };
});

vi.mock("undici", () => ({
  setGlobalDispatcher: mocks.setGlobalDispatcher,
  getGlobalDispatcher: mocks.getGlobalDispatcher,
  ProxyAgent: mocks.ProxyAgent,
  Socks5ProxyAgent: mocks.Socks5ProxyAgent,
}));

vi.mock("@mariozechner/pi-ai", async (importActual) => {
  const actual = await importActual<typeof import("@mariozechner/pi-ai")>();
  return { ...actual, getModel: mocks.getModel };
});

interface FakeAgent {
  replaceMessages: ReturnType<typeof vi.fn>;
  setSystemPrompt: ReturnType<typeof vi.fn>;
}

interface FakeSessionContext {
  agent: FakeAgent;
  session: {
    agent: FakeAgent;
    messages: unknown[];
    subscribe: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
  emit(event: unknown): void;
}

const createFakeSession = (): FakeSessionContext => {
  let listener: ((event: unknown) => void) | undefined;

  const agent: FakeAgent = {
    replaceMessages: vi.fn(),
    setSystemPrompt: vi.fn(),
  };

  const session = {
    agent,
    messages: [] as unknown[],
    subscribe: vi.fn((next: (event: unknown) => void) => {
      listener = next;
      return () => undefined;
    }),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };

  return {
    agent,
    session,
    emit(event: unknown): void {
      listener?.(event);
    },
  };
};

vi.mock("@mariozechner/pi-coding-agent", async (importActual) => {
  const actual = await importActual<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    Agent: mocks.Agent,
    AgentSession: mocks.AgentSession,
  };
});

const createSettings = () => ({
  telegram: { proxy: "", explicit_only: false, allowed_chats: {} },
  ai: { proxy: "", provider: "anthropic", model: "claude-sonnet-4-5" },
  sandbox: "host",
});

describe("agent runner", () => {
  let sandboxDir = "";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getModel.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      reasoning: true,
      contextWindow: 200000,
    });
  });

  afterEach(async () => {
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  const setupFakeSession = (fake: FakeSessionContext) => {
    mocks.Agent.mockImplementation(function () { return fake.agent; });
    mocks.AgentSession.mockImplementation(function () { return fake.session; });
  };

  it("reuses the same runner for one chat", async () => {
    const fake = createFakeSession();
    setupFakeSession(fake);

    const { getOrCreateRunner } = await import("../src/agent.js");
    const settings = createSettings();
    const chatId = `reuse-${Date.now()}`;
    const chatDir = join(tmpdir(), "pigeon-reuse", `chat-${chatId}`);

    const first = getOrCreateRunner(settings, chatId, chatDir);
    const second = getOrCreateRunner(settings, chatId, chatDir);
    expect(first).toBe(second);
  });

  it("writes inbound and bot messages to log.jsonl", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-log-"));
    const chatId = "42";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const result = await runner.run({
      chatId: Number(chatId),
      ts: "1700000000000",
      user: "u1",
      userName: "alice",
      userText: "ping",
    }, store);

    expect(result.stopReason).toBe("stop");
    expect(result.reply).toBe("pong");

    const logPath = join(chatDir, "log.jsonl");
    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const inbound = JSON.parse(lines[0]);
    expect(inbound.user).toBe("u1");
    expect(inbound.text).toBe("ping");
    expect(inbound.isBot).toBe(false);

    const bot = JSON.parse(lines[1]);
    expect(bot.user).toBe("bot");
    expect(bot.text).toBe("pong");
    expect(bot.isBot).toBe(true);
  });

  it("returns aborted stop reason after abort", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-abort-"));
    const chatId = "84";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    let releasePrompt: (() => void) | undefined;
    const waitForAbort = new Promise<void>((resolve) => { releasePrompt = resolve; });

    fake.session.abort.mockImplementationOnce(async () => { releasePrompt?.(); });

    fake.session.prompt.mockImplementationOnce(async () => {
      await waitForAbort;
      const assistant = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const runPromise = runner.run({
      chatId: Number(chatId),
      ts: "1700000001000",
      userName: "bob",
      userText: "long task",
    }, store);

    await Promise.resolve();
    runner.abort();

    const result = await runPromise;
    expect(result.stopReason).toBe("aborted");
  });

  it("refreshes system prompt with memory and skills before each run", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-prompt-"));
    const chatId = "95";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const workspaceMemoryPath = join(dataDir, "MEMORY.md");
    const chatMemoryPath = join(chatDir, "MEMORY.md");
    const skillDir = join(dataDir, "skills", "deploy");
    const fake = createFakeSession();
    setupFakeSession(fake);

    await mkdir(skillDir, { recursive: true });
    await writeFile(workspaceMemoryPath, "global-memory-v1\n", "utf8");
    await mkdir(chatDir, { recursive: true });
    await writeFile(chatMemoryPath, "chat-memory-v1\n", "utf8");
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: deploy\ndescription: deploy helper\n---\n\n# deploy\n", "utf8");

    fake.session.prompt.mockImplementation(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    await runner.run({ chatId: Number(chatId), ts: "1700000002000", user: "u3", userName: "alice", userText: "first" }, store);

    const firstCallArg = fake.agent.setSystemPrompt.mock.calls[0]?.[0] as string;
    expect(firstCallArg).toContain("global-memory-v1");
    expect(firstCallArg).toContain("chat-memory-v1");
    expect(firstCallArg).toContain("deploy helper");

    await writeFile(workspaceMemoryPath, "global-memory-v2\n", "utf8");

    await runner.run({ chatId: Number(chatId), ts: "1700000003000", user: "u3", userName: "alice", userText: "second" }, store);

    const secondCallArg = fake.agent.setSystemPrompt.mock.calls[1]?.[0] as string;
    expect(secondCallArg).toContain("global-memory-v2");
  });

  it("supports async onEvent handlers without dropping them", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-event-"));
    const chatId = "71";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: "done" } });
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    let seenDelta = false;
    let resolveEventHandler: (() => void) | undefined;

    const runPromise = runner.run({
      chatId: Number(chatId),
      ts: "1700000004000",
      user: "u7",
      userName: "eve",
      userText: "event test",
      onEvent: async (event) => {
        if (event.type !== "text_delta") return;
        await new Promise<void>((resolve) => {
          resolveEventHandler = () => { seenDelta = true; resolve(); };
        });
      },
    }, store);

    let runSettled = false;
    void runPromise.then(() => { runSettled = true; });

    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect(seenDelta).toBe(false);

    for (let i = 0; i < 20 && !resolveEventHandler; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(resolveEventHandler).toBeTypeOf("function");
    resolveEventHandler?.();

    const result = await runPromise;
    expect(result.stopReason).toBe("stop");
    expect(seenDelta).toBe(true);
  });

  it("installs socks ai proxy from settings.ai.proxy", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-proxy-"));
    const chatId = "66";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(
      { ...createSettings(), ai: { proxy: "socks5://127.0.0.1:7890", provider: "anthropic", model: "claude-sonnet-4-5" } },
      chatId,
      chatDir,
    );

    await runner.run({ chatId: Number(chatId), ts: "1700000006000", userText: "ping" }, store);

    expect(mocks.Socks5ProxyAgent).toHaveBeenCalledWith("socks5://127.0.0.1:7890");
    expect(mocks.setGlobalDispatcher).toHaveBeenCalled();
  });

  it("surfaces overflow compaction as compaction_start event", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-compact-"));
    const chatId = "80";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      // Real SDK timing: events arrive after prompt resolves
      setTimeout(() => {
        fake.emit({ type: "auto_compaction_start", reason: "overflow" });
        const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
        fake.session.messages.push(assistant);
        fake.emit({ type: "auto_compaction_end", result: {}, aborted: false, willRetry: false });
        fake.emit({ type: "message_end", message: assistant });
      }, 0);
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const events: Array<{ type: string; reason?: string }> = [];
    const result = await runner.run({
      chatId: Number(chatId),
      ts: "1700000010000",
      userText: "overflow test",
      onEvent: async (event) => {
        if (event.type === "compaction_start") {
          events.push({ type: event.type, reason: event.reason });
        }
      },
    }, store);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "compaction_start", reason: "overflow" });
    expect(result.reply).toBe("ok");
  });

  it("waits for overflow recovery before completing run", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-overflow-wait-"));
    const chatId = "83";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    // Real SDK timing: prompt() returns first, then agent_end is processed
    // asynchronously on the event queue, which triggers auto_compaction_start.
    fake.session.prompt.mockImplementationOnce(async () => {
      setTimeout(() => {
        fake.emit({ type: "auto_compaction_start", reason: "overflow" });
      }, 0);
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const events: string[] = [];
    const runPromise = runner.run({
      chatId: Number(chatId),
      ts: "1700000013000",
      userText: "overflow wait test",
      onEvent: async (event) => { events.push(event.type); },
    }, store);

    let settled = false;
    void runPromise.then(() => { settled = true; });

    await new Promise(r => setTimeout(r, 50));
    expect(settled).toBe(false);

    fake.emit({ type: "auto_compaction_end", result: {}, aborted: false, willRetry: true });
    await new Promise(r => setTimeout(r, 10));
    expect(settled).toBe(false);

    const assistant = { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" };
    fake.session.messages.push(assistant);
    fake.emit({ type: "message_end", message: assistant });

    const result = await runPromise;
    expect(result.reply).toBe("recovered");
    expect(events).toContain("compaction_start");
  });

  it("surfaces auto_retry_start as retry event", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-retry-"));
    const chatId = "81";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      fake.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" });
      const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const events: Array<{ type: string; attempt?: number; maxAttempts?: number }> = [];
    await runner.run({
      chatId: Number(chatId),
      ts: "1700000011000",
      userText: "retry test",
      onEvent: async (event) => {
        if (event.type === "retry") {
          events.push({ type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts });
        }
      },
    }, store);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "retry", attempt: 1, maxAttempts: 3 });
  });

  it("does not surface threshold compaction after run completes", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-threshold-"));
    const chatId = "82";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const events: Array<{ type: string }> = [];
    await runner.run({
      chatId: Number(chatId),
      ts: "1700000012000",
      userText: "threshold test",
      onEvent: async (event) => {
        if (event.type === "compaction_start") {
          events.push({ type: event.type });
        }
      },
    }, store);

    fake.emit({ type: "auto_compaction_start", reason: "threshold" });

    expect(events).toHaveLength(0);
  });

  it("completes run when overflow compaction fails (willRetry=false)", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-compact-fail-"));
    const chatId = "84";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      setTimeout(() => {
        fake.emit({ type: "auto_compaction_start", reason: "overflow" });
        fake.emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false,
          errorMessage: "Context overflow recovery failed" });
      }, 0);
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const result = await runner.run({
      chatId: Number(chatId),
      ts: "1700000014000",
      userText: "compact fail test",
    }, store);

    expect(result.stopReason).toBeDefined();
  });

  it("does not leak overflow state across runs", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-cross-run-"));
    const chatId = "85";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    // Run 1: normal
    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    await runner.run({
      chatId: Number(chatId),
      ts: "1700000015000",
      userText: "run 1",
    }, store);

    // Late event from run 1 arrives between runs
    fake.emit({ type: "auto_compaction_start", reason: "overflow" });

    // Run 2: should not be blocked by stale overflow
    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    const result = await runner.run({
      chatId: Number(chatId),
      ts: "1700000016000",
      userText: "run 2",
    }, store);

    expect(result.reply).toBe("second");
  });

  it("waits through retryable error during overflow recovery", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-overflow-retry-"));
    const chatId = "86";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      setTimeout(() => {
        fake.emit({ type: "auto_compaction_start", reason: "overflow" });
        fake.emit({ type: "auto_compaction_end", result: {}, aborted: false, willRetry: true });
        // Recovery prompt hits retryable error
        const errorAssistant = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "overloaded" };
        fake.emit({ type: "message_end", message: errorAssistant });
        // SDK auto-retries
        fake.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" });
      }, 0);
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const events: string[] = [];
    const runPromise = runner.run({
      chatId: Number(chatId),
      ts: "1700000017000",
      userText: "overflow retry test",
      onEvent: async (event) => { events.push(event.type); },
    }, store);

    let settled = false;
    void runPromise.then(() => { settled = true; });

    await new Promise(r => setTimeout(r, 50));
    expect(settled).toBe(false);

    // Retry succeeds
    const okAssistant = { role: "assistant", content: [{ type: "text", text: "finally ok" }], stopReason: "stop" };
    fake.session.messages.push(okAssistant);
    fake.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    fake.emit({ type: "message_end", message: okAssistant });

    const result = await runPromise;
    expect(result.reply).toBe("finally ok");
    expect(events).toContain("compaction_start");
    expect(events).toContain("retry");
  });

  it("completes run when overflow recovery retry is exhausted", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-overflow-exhaust-"));
    const chatId = "87";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();
    setupFakeSession(fake);

    fake.session.prompt.mockImplementationOnce(async () => {
      setTimeout(() => {
        fake.emit({ type: "auto_compaction_start", reason: "overflow" });
        fake.emit({ type: "auto_compaction_end", result: {}, aborted: false, willRetry: true });
        // Recovery prompt fails with retryable error
        const errorAssistant = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "overloaded" };
        fake.emit({ type: "message_end", message: errorAssistant });
        fake.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: "overloaded" });
        // Retry exhausted
        fake.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "max retries exceeded" });
      }, 0);
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const result = await runner.run({
      chatId: Number(chatId),
      ts: "1700000018000",
      userText: "overflow exhaust test",
    }, store);

    expect(result.stopReason).toBeDefined();
  });
});
