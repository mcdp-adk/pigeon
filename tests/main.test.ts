import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SYSTEM_COMMANDS,
  formatHelpReply,
  formatStartReply,
  type TelegramMessage
} from "../src/telegram.js";
import {
  telegramUpdateMessageForwardReplyTopic,
  telegramUpdateMessagePhotoCaption,
  telegramUpdateMessageStartPayload
} from "./fixtures/telegram-updates.js";

const mocks = vi.hoisted(() => {
  const botInstance = {
    init: vi.fn(async () => undefined),
    on: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    api: {
      setMyCommands: vi.fn(async () => true)
    },
    botInfo: {
      id: 777,
      is_bot: true,
      first_name: "Pigeon",
      username: "pigeon_bot"
    }
  };

  return {
    botInstance,
    Bot: vi.fn(function BotMock() {
      return botInstance;
    }),
    HttpsProxyAgent: vi.fn(function HttpsProxyAgentMock(options: unknown) {
      return { kind: "https-proxy", options };
    }),
    SocksProxyAgent: vi.fn(function SocksProxyAgentMock(options: unknown) {
      return { kind: "proxy", options };
    }),
    loadSettings: vi.fn(),
    getChatPolicy: vi.fn(),
    runner: {
      run: vi.fn(),
      abort: vi.fn()
    },
    getOrCreateRunner: vi.fn(),
    storeInstances: [] as Array<{
      workingDir: string;
      getChatDir: ReturnType<typeof vi.fn>;
    }>,
    ChatStore: vi.fn(function ChatStoreMock(this: { workingDir: string; getChatDir: ReturnType<typeof vi.fn> }, config: { workingDir: string }) {
      this.workingDir = config.workingDir;
      this.getChatDir = vi.fn((chatId: string) => `${config.workingDir}/chat-${chatId}`);
      mocks.storeInstances.push(this);
    }),
    responseContexts: [] as Array<{
      sendInitial: ReturnType<typeof vi.fn>;
      updateProgress: ReturnType<typeof vi.fn>;
      appendDelta: ReturnType<typeof vi.fn>;
      sendFinal: ReturnType<typeof vi.fn>;
      markStopped: ReturnType<typeof vi.fn>;
    }>,
    createResponseContext: vi.fn(() => {
      const responseContext = {
        sendInitial: vi.fn(async () => undefined),
        updateProgress: vi.fn(async () => undefined),
        appendDelta: vi.fn(async (_delta: string) => undefined),
        sendFinal: vi.fn(async (_text: string) => undefined),
        markStopped: vi.fn(async () => undefined)
      };
      mocks.responseContexts.push(responseContext);
      return responseContext;
    })
  };
});

const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  if (originalTelegramToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  }
});

vi.mock("grammy", () => ({
  Bot: mocks.Bot
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: mocks.HttpsProxyAgent
}));

vi.mock("socks-proxy-agent", () => ({
  SocksProxyAgent: mocks.SocksProxyAgent
}));

vi.mock("../src/settings.js", () => ({
  loadSettings: mocks.loadSettings,
  getChatPolicy: mocks.getChatPolicy
}));

vi.mock("../src/agent.js", () => ({
  getOrCreateRunner: mocks.getOrCreateRunner
}));

vi.mock("../src/store.js", () => ({
  ChatStore: mocks.ChatStore
}));

vi.mock("../src/telegram.js", async () => {
  const actual = await vi.importActual<typeof import("../src/telegram.js")>("../src/telegram.js");
  return {
    ...actual,
    createResponseContext: mocks.createResponseContext
  };
});

interface TestSettings {
  telegram: {
    proxy: string;
    explicit_only: boolean;
    allowed_chats: Record<string, { explicit_only?: boolean }>;
  };
  ai: { proxy: string; provider: string; model: string };
  sandbox: string;
}

interface TestSettingsOverrides {
  telegram?: Partial<TestSettings["telegram"]>;
  ai?: TestSettings["ai"];
  sandbox?: string;
}

type MessageHandler = (ctx: {
  message: TelegramMessage;
  reply: (text: string, options?: { parse_mode?: "HTML" }) => Promise<void>;
}) => Promise<void>;

const workspaceRoot = process.cwd();
const settingsJsonPath = `${workspaceRoot}/settings.json`;

const createSettings = (overrides: TestSettingsOverrides = {}): TestSettings => {
  return {
    telegram: {
      proxy: "",
      explicit_only: true,
      allowed_chats: { "1001": {} },
      ...(overrides.telegram ?? {})
    },
    ai: overrides.ai ?? { proxy: "", provider: "openai", model: "gpt-4o-mini" },
    sandbox: overrides.sandbox ?? "host"
  };
};

const resolveChatPolicy = (chatId: string | number | bigint, settings: TestSettings) => {
  return {
    explicit_only:
      settings.telegram.allowed_chats[String(chatId)]?.explicit_only ?? settings.telegram.explicit_only
  };
};

const baseMessage: TelegramMessage = {
  message_id: 11,
  date: 0,
  chat: { id: 1001, type: "private" },
  from: { id: 42, is_bot: false, first_name: "Test" }
};

const mergeMessage = (patch: Partial<TelegramMessage>): TelegramMessage => {
  return {
    ...baseMessage,
    ...patch,
    chat: {
      ...baseMessage.chat,
      ...(patch.chat ?? {})
    },
    from:
      patch.from === undefined
        ? baseMessage.from
        : {
            ...baseMessage.from,
            ...patch.from
          }
  } as TelegramMessage;
};

const asMessage = (fixture: { message: unknown }): TelegramMessage => {
  return fixture.message as TelegramMessage;
};

const createContext = (message: TelegramMessage) => {
  return {
    message,
    reply: vi.fn(async (_text: string) => undefined)
  };
};

const getLastResponseContext = () => {
  const responseContext = mocks.responseContexts.at(-1);
  expect(responseContext).toBeDefined();
  return responseContext!;
};

const startHostWithHandler = async () => {
  const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    const { startTelegramHost } = await import("../src/main.js");
    await startTelegramHost();

    const onCall = mocks.botInstance.on.mock.calls.find(([event]) => event === "message");
    expect(onCall).toBeDefined();

    return {
      handler: onCall?.[1] as MessageHandler,
      logSpy,
      warnSpy,
      restore: () => {
        onceSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    };
  } catch (error: unknown) {
    onceSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    throw error;
  }
};

const flushRuns = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

const runStartupSmoke = async () => {
  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("bash", ["-lc", "timeout 8s npm start"], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        FORCE_COLOR: "0"
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
};

describe("main startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    mocks.botInstance.botInfo = {
      id: 777,
      is_bot: true,
      first_name: "Pigeon",
      username: "pigeon_bot"
    };
    mocks.botInstance.init.mockResolvedValue(undefined);
    mocks.botInstance.on.mockImplementation(() => mocks.botInstance);
    mocks.botInstance.start.mockResolvedValue(undefined);
    mocks.botInstance.api.setMyCommands.mockResolvedValue(true);

    mocks.loadSettings.mockResolvedValue(createSettings());
    mocks.getChatPolicy.mockImplementation(resolveChatPolicy);
    mocks.runner.run.mockResolvedValue({ stopReason: "stop", reply: "runner reply" });
    mocks.runner.abort.mockReset();
    mocks.getOrCreateRunner.mockImplementation(() => mocks.runner);
    mocks.storeInstances.length = 0;
    mocks.responseContexts.length = 0;
  });

  it("startup: init runs before handler registration and bot.start uses message updates", async () => {
    const order: string[] = [];
    mocks.botInstance.init.mockImplementationOnce(async () => {
      order.push("init");
    });
    mocks.botInstance.api.setMyCommands.mockImplementationOnce(async () => {
      order.push("commands");
      return true;
    });
    mocks.botInstance.on.mockImplementationOnce(() => {
      order.push("on");
      return mocks.botInstance;
    });

    const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const { startTelegramHost } = await import("../src/main.js");
      await startTelegramHost();

      expect(mocks.Bot).toHaveBeenCalledWith("bot-token", undefined);
      expect(order).toEqual(["init", "commands", "on"]);
      expect(mocks.botInstance.api.setMyCommands).toHaveBeenCalledWith([...SYSTEM_COMMANDS]);
      expect(mocks.botInstance.start).toHaveBeenCalledWith({
        allowed_updates: ["message"]
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Initializing Telegram host")
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Telegram host started")
      );
      expect(onceSpy).toHaveBeenNthCalledWith(1, "SIGINT", expect.any(Function));
      expect(onceSpy).toHaveBeenNthCalledWith(2, "SIGTERM", expect.any(Function));
    } finally {
      onceSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("startup: /start bypasses gate even for unauthorized chats", async () => {
    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 404, type: "private" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        formatStartReply(message, "pigeon_bot", false).text,
        { parse_mode: "HTML" }
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Handled command command=start")
      );
    } finally {
      restore();
    }
  });

  it("startup: /start payload reply stays on bypass path", async () => {
    const { handler, restore } = await startHostWithHandler();

    try {
      const message = asMessage(telegramUpdateMessageStartPayload);
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        formatStartReply(message, "pigeon_bot", false).text,
        { parse_mode: "HTML" }
      );
      expect(ctx.reply.mock.calls[0]?.[0]).toContain("start_payload:");
    } finally {
      restore();
    }
  });

  it("startup: /start shows enabled guidance for authorized chats", async () => {
    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        formatStartReply(message, "pigeon_bot", true).text,
        { parse_mode: "HTML" }
      );
    } finally {
      restore();
    }
  });

  it("startup: /help bypasses gate and returns command help", async () => {
    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 404, type: "private" },
        text: "/help",
        entities: [{ type: "bot_command", offset: 0, length: 5 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        formatHelpReply("pigeon_bot").text,
        { parse_mode: "HTML" }
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Handled command command=help")
      );
    } finally {
      restore();
    }
  });

  it("startup: /stop bypasses gate even for unauthorized chats", async () => {
    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 404, type: "private" },
        text: "/stop",
        entities: [{ type: "bot_command", offset: 0, length: 5 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith("<b>ℹ️ 没有正在运行的任务</b>", { parse_mode: "HTML" });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Handled command command=stop"));
    } finally {
      restore();
    }
  });

  it("startup: /stop replies idle when no run is active", async () => {
    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        text: "/stop",
        entities: [{ type: "bot_command", offset: 0, length: 5 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.runner.abort).not.toHaveBeenCalled();
      expect(mocks.createResponseContext).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith("<b>ℹ️ 没有正在运行的任务</b>", { parse_mode: "HTML" });
    } finally {
      restore();
    }
  });

  it("startup: /stop@pigeon_bot stops an active run", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    let resolveRun: (() => void) | undefined;
    const runPromise = new Promise<{ stopReason: string; reply: string }>((resolve) => {
      resolveRun = () => resolve({ stopReason: "aborted", reply: "" });
    });
    mocks.runner.run.mockImplementation(() => runPromise);

    const { handler, restore } = await startHostWithHandler();

    try {
      const firstCtx = createContext(mergeMessage({ text: "first" }));
      const firstRunPromise = handler(firstCtx);
      await Promise.resolve();

      const responseContext = getLastResponseContext();

      const stopCtx = createContext(
        mergeMessage({
          text: "/stop@pigeon_bot",
          entities: [{ type: "bot_command", offset: 0, length: 16 }]
        })
      );

      await handler(stopCtx);

      expect(mocks.runner.abort).toHaveBeenCalledTimes(1);
      expect(responseContext.markStopped).toHaveBeenCalled();
      expect(stopCtx.reply).not.toHaveBeenCalled();
      expect(responseContext.sendFinal).not.toHaveBeenCalled();

      resolveRun?.();
      await firstRunPromise;

      expect(responseContext.sendFinal).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("startup: ignores system commands addressed to another bot", async () => {
    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 404, type: "group" },
        text: "/help@otherbot",
        entities: [{ type: "bot_command", offset: 0, length: 14 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).toHaveBeenCalledWith(404, expect.any(Object));
      expect(ctx.reply).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("startup: does not route plain text that only mentions /stop mid-message as stop command", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const ctx = createContext(
        mergeMessage({
          text: "Use the bash tool, then maybe /stop later",
          entities: [{ type: "bot_command", offset: 30, length: 5 }]
        })
      );

      await handler(ctx);

      const responseContext = getLastResponseContext();
      expect(mocks.runner.abort).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalledWith("<b>ℹ️ 没有正在运行的任务</b>", { parse_mode: "HTML" });
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(mocks.runner.run).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("startup: unauthorized non-start messages stay silent", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 9999, type: "private" },
        text: "hello from outside"
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).toHaveBeenCalledWith(9999, expect.any(Object));
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Ignored message reason=unauthorized_chat")
      );
    } finally {
      restore();
    }
  });

  it("startup: explicit_only false allows ordinary allowed-chat text", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({ text: "hello team" });
      const ctx = createContext(message);

      await handler(ctx);
      await flushRuns();

      const responseContext = getLastResponseContext();
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(responseContext.sendFinal).toHaveBeenCalledWith("runner reply");
      expect(mocks.runner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 1001,
          ts: "0",
          userText: "hello team",
          user: "Test",
          userName: "Test"
        }),
        expect.objectContaining({
          getChatDir: expect.any(Function)
        })
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Handled message reason=allowed_chat")
      );
    } finally {
      restore();
    }
  });

  it("startup: reply-to-bot enters debug path under explicit_only", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: true,
          allowed_chats: { "-100987": {} }
        }
      })
    );
    mocks.botInstance.botInfo = {
      id: 11,
      is_bot: true,
      first_name: "Pigeon",
      username: "pigeon_bot"
    };

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = asMessage(telegramUpdateMessageForwardReplyTopic);
      const ctx = createContext(message);

      await handler(ctx);
      await flushRuns();

      const responseContext = getLastResponseContext();
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(responseContext.sendFinal).toHaveBeenCalledWith("runner reply");
      expect(mocks.runner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: telegramUpdateMessageForwardReplyTopic.message.chat.id,
          userText: telegramUpdateMessageForwardReplyTopic.message.text
        }),
        expect.any(Object)
      );
    } finally {
      restore();
    }
  });

  it("startup: mention enters debug path under explicit_only", async () => {
    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        text: "ping @PIGEON_BOT please",
        entities: [{ type: "mention", offset: 5, length: 11 }]
      });
      const ctx = createContext(message);

      await handler(ctx);
      await flushRuns();

      const responseContext = getLastResponseContext();
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(responseContext.sendFinal).toHaveBeenCalledWith("runner reply");
    } finally {
      restore();
    }
  });

  it("startup: photo plus caption enters extraction and debug reply path", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "-100987": {} }
        }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = asMessage(telegramUpdateMessagePhotoCaption);
      const ctx = createContext(message);

      await handler(ctx);
      await flushRuns();

      const responseContext = getLastResponseContext();
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(mocks.runner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: telegramUpdateMessagePhotoCaption.message.caption
        }),
        expect.any(Object)
      );
      expect(responseContext.sendFinal).toHaveBeenCalledWith("runner reply");
    } finally {
      restore();
    }
  });

  it("startup: service messages are skipped without reply", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        new_chat_members: [{ id: 88, is_bot: false, first_name: "New user" }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Ignored message reason=non_user_content")
      );
    } finally {
      restore();
    }
  });

  it("startup: per-chat override can relax the default explicit gate", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: true,
          allowed_chats: {
            "1001": { explicit_only: false }
          }
        }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({ text: "ordinary group text" });
      const ctx = createContext(message);

      await handler(ctx);
      await flushRuns();

      expect(mocks.getChatPolicy).toHaveBeenCalledWith(1001, expect.any(Object));
      const responseContext = getLastResponseContext();
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(responseContext.sendFinal).toHaveBeenCalledWith("runner reply");
    } finally {
      restore();
    }
  });

  it("startup: unsupported non-text content gets a markdown reply without starting a run", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        photo: [{}]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith("<b>⚠️ 无法处理此消息</b>\n\n仅支持纯文字消息，请发送文字内容。", {
        parse_mode: "HTML"
      });
      expect(mocks.createResponseContext).not.toHaveBeenCalled();
      expect(mocks.runner.run).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("startup: a second message in the same chat gets the busy reply", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );
    let resolveRun: (() => void) | undefined;
    const runPromise = new Promise<{ stopReason: string; reply: string }>((resolve) => {
      resolveRun = () => resolve({ stopReason: "stop", reply: "runner reply" });
    });
    mocks.runner.run.mockImplementation(() => runPromise);

    const { handler, restore } = await startHostWithHandler();

    try {
      const firstCtx = createContext(mergeMessage({ text: "first" }));
      const secondCtx = createContext(mergeMessage({ message_id: 12, text: "second" }));

      const firstRun = handler(firstCtx);
      await Promise.resolve();

      await handler(secondCtx);

      expect(secondCtx.reply).toHaveBeenCalledWith(
        "<b>⏳ 正在处理上一条消息</b>\n\n请稍候，或发送 /stop 取消当前任务。",
        { parse_mode: "HTML" }
      );
      expect(mocks.runner.run).toHaveBeenCalledTimes(1);

      resolveRun?.();
      await firstRun;
    } finally {
      restore();
    }
  });

  it("startup: accepted text messages stream progress through response context and send final reply", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );
    mocks.runner.run.mockImplementation(async (input) => {
      await input.onEvent?.({
        type: "tool_start",
        toolName: "read",
        label: "read",
      });
      await input.onEvent?.({
        type: "tool_end",
        toolName: "read",
        label: "read",
        isError: false,
      });
      return {
        stopReason: "stop",
        reply: "final answer"
      };
    });

    const { handler, restore } = await startHostWithHandler();

    try {
      const ctx = createContext(mergeMessage({ text: "hello team" }));

      await handler(ctx);
      await flushRuns();

      const responseContext = getLastResponseContext();
      expect(responseContext.sendInitial).toHaveBeenCalledOnce();
      expect(responseContext.updateProgress).toHaveBeenNthCalledWith(1, "调用工具：read");
      expect(responseContext.updateProgress).toHaveBeenNthCalledWith(2, "工具完成：read");
      expect(responseContext.sendFinal).toHaveBeenCalledWith("final answer");
      expect(mocks.getOrCreateRunner).toHaveBeenCalledWith(
        expect.any(Object),
        "1001",
        `${process.cwd()}/data/chat-1001`
      );
      expect(mocks.storeInstances[0]?.workingDir).toBe(`${process.cwd()}/data`);
    } finally {
      restore();
    }
  });

  it("startup: explicit_only gate logs ignored ordinary messages", async () => {
    const { handler, logSpy, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({ text: "ordinary text" });
      const ctx = createContext(message);

      await handler(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Ignored message reason=explicit_gate")
      );
    } finally {
      restore();
    }
  });
});

describe("main proxy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          proxy: "http://127.0.0.1:7890",
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );
    mocks.getChatPolicy.mockImplementation(resolveChatPolicy);
    mocks.botInstance.on.mockImplementation(() => mocks.botInstance);
    mocks.botInstance.start.mockResolvedValue(undefined);
  });

  it("proxy: injects https proxy agent via client.baseFetchConfig.agent", async () => {
    const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const { startTelegramHost } = await import("../src/main.js");
      await startTelegramHost();

      expect(mocks.HttpsProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:7890");
      const proxyInstance = mocks.HttpsProxyAgent.mock.results[0]?.value;
      const botCall = (mocks.Bot as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const botOptions = botCall?.[1] as {
        client?: {
          baseFetchConfig?: {
            compress?: boolean;
            agent?: unknown;
          };
        };
      } | undefined;

      expect(botOptions?.client?.baseFetchConfig?.agent).toBe(proxyInstance);
      expect(botOptions?.client?.baseFetchConfig?.compress).toBe(true);
    } finally {
      onceSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("proxy: normalizes socks5 URLs to remote-DNS socks5h agent", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          proxy: "socks5://127.0.0.1:7890",
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );

    const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const { startTelegramHost } = await import("../src/main.js");
      await startTelegramHost();

      expect(mocks.SocksProxyAgent).toHaveBeenCalledWith("socks5h://127.0.0.1:7890");
      const proxyInstance = mocks.SocksProxyAgent.mock.results[0]?.value;
      const botCall = (mocks.Bot as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const botOptions = botCall?.[1] as {
        client?: {
          baseFetchConfig?: {
            compress?: boolean;
            agent?: unknown;
          };
        };
      } | undefined;

      expect(botOptions?.client?.baseFetchConfig?.agent).toBe(proxyInstance);
      expect(botOptions?.client?.baseFetchConfig?.compress).toBe(true);
    } finally {
      onceSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("main signal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          explicit_only: false,
          allowed_chats: { "1001": {} }
        }
      })
    );
    mocks.getChatPolicy.mockImplementation(resolveChatPolicy);
    mocks.botInstance.on.mockImplementation(() => mocks.botInstance);
    mocks.botInstance.start.mockResolvedValue(undefined);
  });

  it("signal: SIGINT and SIGTERM handlers call bot.stop", async () => {
    const signalHandlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
    const onceSpy = vi.spyOn(process, "once").mockImplementation((signal, listener) => {
      if (signal === "SIGINT" || signal === "SIGTERM") {
        signalHandlers[signal] = listener as () => void;
      }
      return process;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const { startTelegramHost } = await import("../src/main.js");
      await startTelegramHost();

      signalHandlers.SIGINT?.();
      signalHandlers.SIGTERM?.();

      expect(mocks.botInstance.stop).toHaveBeenCalledTimes(2);
    } finally {
      onceSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("main startup smoke", () => {
  if (!existsSync(settingsJsonPath)) {
    it.skip("startup smoke: skips cleanly when settings.json is absent", () => undefined);
    return;
  }

  it(
    "startup smoke: npm start boots long enough to print startup log",
    async () => {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        return;
      }

      const result = await runStartupSmoke();
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      expect(combinedOutput).toContain("Telegram host started");

      if (result.code === 1) {
        expect(combinedOutput).toContain("409: Conflict");
      } else {
        expect([0, 124]).toContain(result.code);
      }
    },
    15000
  );
});
