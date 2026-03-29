import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractMessageContent,
  formatDebugReply,
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
    getChatPolicy: vi.fn()
  };
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

interface TestSettings {
  telegram: {
    token: string;
    proxy: string;
  };
  explicit_only: boolean;
  allowed_chats: Record<string, { explicit_only?: boolean }>;
}

type MessageHandler = (ctx: {
  message: TelegramMessage;
  reply: (text: string) => Promise<void>;
}) => Promise<void>;

const workspaceRoot = process.cwd();
const settingsJsonPath = `${workspaceRoot}/settings.json`;

const createSettings = (overrides: Partial<TestSettings> = {}): TestSettings => {
  return {
    telegram: {
      token: "bot-token",
      proxy: "",
      ...(overrides.telegram ?? {})
    },
    explicit_only: overrides.explicit_only ?? true,
    allowed_chats: overrides.allowed_chats ?? { "1001": {} }
  };
};

const resolveChatPolicy = (chatId: string | number | bigint, settings: TestSettings) => {
  return {
    explicit_only: settings.allowed_chats[String(chatId)]?.explicit_only ?? settings.explicit_only
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

const startHostWithHandler = async () => {
  const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const { startTelegramHost } = await import("../src/main.js");
    await startTelegramHost();

    const onCall = mocks.botInstance.on.mock.calls.find(([event]) => event === "message");
    expect(onCall).toBeDefined();

    return {
      handler: onCall?.[1] as MessageHandler,
      restore: () => {
        onceSpy.mockRestore();
        logSpy.mockRestore();
      }
    };
  } catch (error: unknown) {
    onceSpy.mockRestore();
    logSpy.mockRestore();
    throw error;
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

    mocks.botInstance.botInfo = {
      id: 777,
      is_bot: true,
      first_name: "Pigeon",
      username: "pigeon_bot"
    };
    mocks.botInstance.init.mockResolvedValue(undefined);
    mocks.botInstance.on.mockImplementation(() => mocks.botInstance);
    mocks.botInstance.start.mockResolvedValue(undefined);

    mocks.loadSettings.mockResolvedValue(createSettings());
    mocks.getChatPolicy.mockImplementation(resolveChatPolicy);
  });

  it("startup: init runs before handler registration and bot.start uses message updates", async () => {
    const order: string[] = [];
    mocks.botInstance.init.mockImplementationOnce(async () => {
      order.push("init");
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
      expect(order).toEqual(["init", "on"]);
      expect(mocks.botInstance.start).toHaveBeenCalledWith({
        allowed_updates: ["message"]
      });
      expect(onceSpy).toHaveBeenNthCalledWith(1, "SIGINT", expect.any(Function));
      expect(onceSpy).toHaveBeenNthCalledWith(2, "SIGTERM", expect.any(Function));
    } finally {
      onceSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("startup: /start bypasses gate even for unauthorized chats", async () => {
    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 404, type: "private" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(formatStartReply(message, "pigeon_bot"));
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
      expect(ctx.reply).toHaveBeenCalledWith(formatStartReply(message, "pigeon_bot"));
      expect(ctx.reply.mock.calls[0]?.[0]).toContain("start_payload=ticket-42");
    } finally {
      restore();
    }
  });

  it("startup: unauthorized non-start messages stay silent", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: false,
        allowed_chats: { "1001": {} }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        chat: { id: 9999, type: "private" },
        text: "hello from outside"
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).toHaveBeenCalledWith(9999, expect.any(Object));
      expect(ctx.reply).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("startup: explicit_only false allows ordinary allowed-chat text", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: false,
        allowed_chats: { "1001": {} }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({ text: "hello team" });
      const ctx = createContext(message);

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        formatDebugReply(extractMessageContent(message))
      );
    } finally {
      restore();
    }
  });

  it("startup: reply-to-bot enters debug path under explicit_only", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: true,
        allowed_chats: { "-100987": {} }
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

      expect(ctx.reply).toHaveBeenCalledWith(
        formatDebugReply(extractMessageContent(message))
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

      expect(ctx.reply).toHaveBeenCalledWith(
        formatDebugReply(extractMessageContent(message))
      );
    } finally {
      restore();
    }
  });

  it("startup: photo plus caption enters extraction and debug reply path", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: false,
        allowed_chats: { "-100987": {} }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = asMessage(telegramUpdateMessagePhotoCaption);
      const ctx = createContext(message);

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        formatDebugReply(extractMessageContent(message))
      );
    } finally {
      restore();
    }
  });

  it("startup: service messages are skipped without reply", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: false,
        allowed_chats: { "1001": {} }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({
        new_chat_members: [{ id: 88, is_bot: false, first_name: "New user" }]
      });
      const ctx = createContext(message);

      await handler(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("startup: per-chat override can relax the default explicit gate", async () => {
    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: true,
        allowed_chats: {
          "1001": { explicit_only: false }
        }
      })
    );

    const { handler, restore } = await startHostWithHandler();

    try {
      const message = mergeMessage({ text: "ordinary group text" });
      const ctx = createContext(message);

      await handler(ctx);

      expect(mocks.getChatPolicy).toHaveBeenCalledWith(1001, expect.any(Object));
      expect(ctx.reply).toHaveBeenCalledWith(
        formatDebugReply(extractMessageContent(message))
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

    mocks.loadSettings.mockResolvedValue(
      createSettings({
        telegram: {
          token: "bot-token",
          proxy: "http://127.0.0.1:7890"
        },
        explicit_only: false,
        allowed_chats: { "1001": {} }
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
          token: "bot-token",
          proxy: "socks5://127.0.0.1:7890"
        },
        explicit_only: false,
        allowed_chats: { "1001": {} }
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

    mocks.loadSettings.mockResolvedValue(
      createSettings({
        explicit_only: false,
        allowed_chats: { "1001": {} }
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
      const result = await runStartupSmoke();
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      expect(combinedOutput).toContain("Telegram host started");
      expect([0, 124]).toContain(result.code);
    },
    15000
  );
});
