import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createAgentSession = vi.fn();
  const getModel = vi.fn();
  return {
    createAgentSession,
    getModel
  };
});

vi.mock("@mariozechner/pi-coding-agent", async (importActual) => {
  const actual = await importActual<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: mocks.createAgentSession
  };
});

vi.mock("@mariozechner/pi-ai", async (importActual) => {
  const actual = await importActual<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    getModel: mocks.getModel
  };
});

interface FakeSessionContext {
  session: {
    agent: { replaceMessages: ReturnType<typeof vi.fn> };
    messages: unknown[];
    subscribe: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
  emit(event: unknown): void;
}

const createFakeSession = (): FakeSessionContext => {
  let listener: ((event: any) => void) | undefined;

  const session = {
    agent: {
      replaceMessages: vi.fn()
    },
    messages: [] as unknown[],
    subscribe: vi.fn((next: (event: any) => void) => {
      listener = next;
      return () => undefined;
    }),
    reload: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined)
  };

  return {
    session,
    emit(event: unknown): void {
      listener?.(event);
    }
  };
};

const createSettings = () => {
  return {
    telegram: { proxy: "" },
    ai: { provider: "anthropic", model: "claude-sonnet-4-5" },
    sandbox: "host",
    explicit_only: false,
    allowed_chats: {}
  };
};

describe("agent runner", () => {
  let sandboxDir = "";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getModel.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      reasoning: true,
      contextWindow: 200000
    });
  });

  afterEach(async () => {
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("reuses the same runner for one chat", async () => {
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

    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        stopReason: "stop"
      };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    mocks.createAgentSession.mockResolvedValueOnce({
      session: fake.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} }
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
      userText: "ping"
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

    let releasePrompt: (() => void) | undefined;
    const waitForAbort = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    fake.session.abort.mockImplementationOnce(async () => {
      releasePrompt?.();
    });

    fake.session.prompt.mockImplementationOnce(async () => {
      await waitForAbort;
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted"
      };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    mocks.createAgentSession.mockResolvedValueOnce({
      session: fake.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} }
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const runPromise = runner.run({
      chatId: Number(chatId),
      ts: "1700000001000",
      userName: "bob",
      userText: "long task"
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

    await mkdir(skillDir, { recursive: true });
    await writeFile(workspaceMemoryPath, "global-memory-v1\n", "utf8");
    await mkdir(chatDir, { recursive: true });
    await writeFile(chatMemoryPath, "chat-memory-v1\n", "utf8");
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: deploy helper\n---\n\n# deploy\n",
      "utf8"
    );

    fake.session.prompt.mockImplementation(async () => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop"
      };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    mocks.createAgentSession.mockResolvedValueOnce({
      session: fake.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} }
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    await runner.run(
      {
        chatId: Number(chatId),
        ts: "1700000002000",
        user: "u3",
        userName: "alice",
        userText: "first"
      },
      store
    );

    const firstCall = mocks.createAgentSession.mock.calls[0]?.[0] as {
      resourceLoader: { getSystemPrompt: () => string };
    };
    const firstPrompt = firstCall.resourceLoader.getSystemPrompt();
    expect(firstPrompt).toContain("global-memory-v1");
    expect(firstPrompt).toContain("chat-memory-v1");
    expect(firstPrompt).toContain("deploy helper");

    await writeFile(workspaceMemoryPath, "global-memory-v2\n", "utf8");

    await runner.run(
      {
        chatId: Number(chatId),
        ts: "1700000003000",
        user: "u3",
        userName: "alice",
        userText: "second"
      },
      store
    );

    const secondPrompt = firstCall.resourceLoader.getSystemPrompt();
    expect(secondPrompt).toContain("global-memory-v2");
  });

  it("supports async onEvent handlers without dropping them", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-event-"));
    const chatId = "71";
    const dataDir = join(sandboxDir, "data");
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();

    fake.session.prompt.mockImplementationOnce(async () => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop"
      };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    mocks.createAgentSession.mockResolvedValueOnce({
      session: fake.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} }
    });

    const { getOrCreateRunner } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    let seenMessageEnd = false;
    let resolveEventHandler: (() => void) | undefined;

    const runPromise = runner.run(
      {
        chatId: Number(chatId),
        ts: "1700000004000",
        user: "u7",
        userName: "eve",
        userText: "event test",
        onEvent: async (event) => {
          if (event.type !== "message_end") {
            return;
          }

          await new Promise<void>((resolve) => {
            resolveEventHandler = () => {
              seenMessageEnd = true;
              resolve();
            };
          });
        }
      },
      store
    );

    let runSettled = false;
    void runPromise.then(() => {
      runSettled = true;
    });

    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect(seenMessageEnd).toBe(false);

    for (let i = 0; i < 20 && !resolveEventHandler; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(resolveEventHandler).toBeTypeOf("function");
    resolveEventHandler?.();

    const result = await runPromise;
    expect(result.stopReason).toBe("stop");
    expect(seenMessageEnd).toBe(true);
  });

  it("keeps runner cache bounded", async () => {
    const { getOrCreateRunner, getRunnerCacheSizeForTests } = await import("../src/agent.js");
    const settings = createSettings();
    const maxPlusExtra = 130;
    let firstRunner: unknown;

    for (let i = 0; i < maxPlusExtra; i += 1) {
      const chatId = String(1000 + i);
      const chatDir = join(tmpdir(), "pigeon-cache", `chat-${chatId}`);
      const runner = getOrCreateRunner(settings, chatId, chatDir);
      if (i === 0) {
        firstRunner = runner;
      }
    }

    expect(getRunnerCacheSizeForTests()).toBeLessThanOrEqual(100);

    const firstRunnerAgain = getOrCreateRunner(settings, "1000", join(tmpdir(), "pigeon-cache", "chat-1000"));
    expect(firstRunnerAgain).not.toBe(firstRunner);
  });

  it("shrinks oversized cache after active runs settle", async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agent-cache-shrink-"));
    const dataDir = join(sandboxDir, "data");
    const chatId = "7001";
    const chatDir = join(dataDir, `chat-${chatId}`);
    const fake = createFakeSession();

    let releaseRun: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    fake.session.prompt.mockImplementationOnce(async () => {
      await gate;
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop"
      };
      fake.session.messages.push(assistant);
      fake.emit({ type: "message_end", message: assistant });
    });

    mocks.createAgentSession.mockResolvedValueOnce({
      session: fake.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} }
    });

    const {
      addSyntheticActiveRunnerForTests,
      clearRunnerCacheForTests,
      getOrCreateRunner,
      getRunnerCacheSizeForTests
    } = await import("../src/agent.js");
    const { ChatStore } = await import("../src/store.js");
    clearRunnerCacheForTests();

    const syntheticHandles = Array.from({ length: 120 }, (_, i) => {
      return addSyntheticActiveRunnerForTests(String(9000 + i));
    });
    expect(getRunnerCacheSizeForTests()).toBe(120);

    const store = new ChatStore({ workingDir: dataDir });
    const runner = getOrCreateRunner(createSettings(), chatId, chatDir);

    const runPromise = runner.run(
      {
        chatId: Number(chatId),
        ts: "1700000005000",
        user: "u9",
        userName: "zoe",
        userText: "shrink"
      },
      store
    );

    for (const handle of syntheticHandles) {
      handle.deactivate();
    }

    releaseRun?.();
    await runPromise;

    expect(getRunnerCacheSizeForTests()).toBeLessThanOrEqual(100);
  });
});
