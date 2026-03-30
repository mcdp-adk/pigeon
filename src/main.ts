import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import { getOrCreateRunner, type AgentRunner } from "./agent.js";
import { logError, logInfo } from "./log.js";
import { getChatPolicy, loadSettings, type Settings } from "./settings.js";
import { ChatStore } from "./store.js";
import {
  SYSTEM_COMMANDS,
  createResponseContext,
  extractCommandForBot,
  extractMessageContent,
  formatHelpReply,
  formatStartReply,
  getMessageHandlingDecision,
  isChatAllowed,
  type TelegramReply,
  type TelegramMessage
} from "./telegram.js";

const isTelegramMessage = (value: unknown): value is TelegramMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Partial<TelegramMessage>;
  return (
    typeof message.message_id === "number" &&
    typeof message.date === "number" &&
    typeof message.chat === "object" &&
    message.chat !== null &&
    typeof message.chat.id === "number" &&
    typeof message.chat.type === "string"
  );
};

const createProxyConfig = (proxy: string): { agent?: HttpsProxyAgent<string> | SocksProxyAgent; label: string } => {
  const trimmedProxy = proxy.trim();
  if (trimmedProxy === "") {
    return { agent: undefined, label: "none" };
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(trimmedProxy);
  } catch {
    throw new Error("Invalid telegram.proxy URL");
  }

  const protocol = proxyUrl.protocol;

  if (protocol === "http:" || protocol === "https:") {
    return {
      agent: new HttpsProxyAgent(trimmedProxy),
      label: protocol.slice(0, -1)
    };
  }

  if (protocol === "socks5:" || protocol === "socks5h:") {
    const normalizedProxy = new URL(trimmedProxy);
    normalizedProxy.protocol = "socks5h:";
    return {
      agent: new SocksProxyAgent(normalizedProxy.toString()),
      label: "socks5h"
    };
  }

  throw new Error(`Unsupported telegram.proxy protocol: ${protocol}`);
};

const withOptionalProxyConfig = (proxyAgent: HttpsProxyAgent<string> | SocksProxyAgent | undefined) => {
  if (!proxyAgent) {
    return undefined;
  }

  return {
    client: {
      baseFetchConfig: {
        agent: proxyAgent,
        compress: true
      }
    }
  };
};

const sendTelegramReply = async (
  reply: TelegramReply,
  send: (text: string, options?: { parse_mode?: "HTML" }) => Promise<unknown>
) => {
  if (reply.kind === "html") {
    await send(reply.text, { parse_mode: "HTML" });
    return;
  }

  await send(reply.text);
};

interface ChatState {
  running: boolean;
  stopRequested: boolean;
  runner: AgentRunner;
  store: ChatStore;
}

const DATA_DIR = resolve(process.cwd(), "data");
const BUSY_REPLY = "_已在处理上一条消息，请等待或发送 /stop 取消。_";
const UNSUPPORTED_TEXT_REPLY = "_目前只支持文字消息。_";
const RUN_FAILED_REPLY = "_处理失败，请稍后重试。_";
const EMPTY_REPLY = "_未返回文本结果。_";

const chatStates = new Map<string, ChatState>();

const getOrCreateChatState = (chatId: number, settings: Settings): ChatState => {
  const chatKey = String(chatId);
  const existing = chatStates.get(chatKey);
  if (existing) {
    return existing;
  }

  const store = new ChatStore({ workingDir: DATA_DIR });
  const chatDir = store.getChatDir(chatKey);
  const state: ChatState = {
    running: false,
    stopRequested: false,
    runner: getOrCreateRunner(settings, chatKey, chatDir),
    store
  };
  chatStates.set(chatKey, state);
  return state;
};

const getMessageText = (message: TelegramMessage): string | undefined => {
  return message.text ?? message.caption;
};

const getMessageTimestamp = (message: TelegramMessage): string => {
  return String(message.date * 1000);
};

const getUserHandle = (message: TelegramMessage): string => {
  return message.from?.username ?? message.from?.first_name ?? "telegram-user";
};

const getUserName = (message: TelegramMessage): string | undefined => {
  return message.from?.first_name ?? message.from?.username;
};

const getToolProgressLabel = (event: AgentSessionEvent): string | undefined => {
  if (event.type === "tool_execution_start") {
    return `调用工具：${event.toolName}`;
  }

  if (event.type === "tool_execution_end") {
    return event.isError ? `工具失败：${event.toolName}` : `工具完成：${event.toolName}`;
  }

  return undefined;
};

export const startTelegramHost = async () => {
  const settings = await loadSettings();
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken || telegramToken.trim() === "") {
    throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
  }
  const proxyConfig = createProxyConfig(settings.telegram.proxy);

  logInfo("Initializing Telegram host", {
    explicit_only: settings.explicit_only,
    allowed_chats: Object.keys(settings.allowed_chats).length,
    proxy: proxyConfig.label
  });

  mkdirSync(DATA_DIR, { recursive: true });
  const bot = new Bot(telegramToken, withOptionalProxyConfig(proxyConfig.agent));

  await bot.init();
  const botInfo = bot.botInfo;
  if (!botInfo) {
    throw new Error("Bot info is not available after init");
  }

  const botName = botInfo.username ?? botInfo.first_name;

  logInfo("Telegram bot initialized", {
    bot_id: botInfo.id,
    bot_name: botName
  });

  await bot.api.setMyCommands([...SYSTEM_COMMANDS]);
  logInfo("Registered Telegram commands", {
    commands: SYSTEM_COMMANDS.map((command) => command.command).join(",")
  });

  bot.on("message", async (ctx) => {
    if (!isTelegramMessage(ctx.message)) {
      logInfo("Ignored update", {
        reason: "unsupported_message_shape"
      });
      return;
    }

    const message = ctx.message;
    const command = extractCommandForBot(message, botInfo.username);

    if (command.commandName === "start") {
      const isAuthorized = isChatAllowed(message.chat.id, settings.allowed_chats);
      await sendTelegramReply(formatStartReply(message, botName, isAuthorized), ctx.reply.bind(ctx));
      logInfo("Handled command", {
        command: command.commandName,
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        message_id: message.message_id
      });
      return;
    }

    if (command.commandName === "help") {
      await sendTelegramReply(formatHelpReply(botName), ctx.reply.bind(ctx));
      logInfo("Handled command", {
        command: command.commandName,
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        message_id: message.message_id
      });
      return;
    }

    const chatPolicy = getChatPolicy(message.chat.id, settings);
    const decision = getMessageHandlingDecision(message, {
      explicitOnly: chatPolicy.explicit_only,
      allowedChats: settings.allowed_chats,
      botId: botInfo.id,
      botUsername: botInfo.username
    });

    if (!decision.shouldHandle) {
      logInfo("Ignored message", {
        reason: decision.reason,
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        message_id: message.message_id,
        from_id: message.from?.id,
        explicit_only: chatPolicy.explicit_only
      });
      return;
    }

    const extracted = extractMessageContent(message);
    const userText = getMessageText(message);
    if (!userText) {
      await ctx.reply(UNSUPPORTED_TEXT_REPLY, { parse_mode: "Markdown" });
      logInfo("Handled message", {
        reason: decision.reason,
        chat_id: extracted.chatId,
        chat_type: extracted.chatType,
        message_id: extracted.messageId,
        from_id: extracted.fromId,
        content_type: extracted.contentType,
        explicit_only: chatPolicy.explicit_only,
        result: "unsupported_text"
      });
      return;
    }

    const state = getOrCreateChatState(message.chat.id, settings);
    if (state.running) {
      await ctx.reply(BUSY_REPLY, { parse_mode: "Markdown" });
      logInfo("Handled message", {
        reason: decision.reason,
        chat_id: extracted.chatId,
        chat_type: extracted.chatType,
        message_id: extracted.messageId,
        from_id: extracted.fromId,
        content_type: extracted.contentType,
        explicit_only: chatPolicy.explicit_only,
        result: "busy"
      });
      return;
    }

    const responseCtx = createResponseContext(ctx);
    state.running = true;
    state.stopRequested = false;

    try {
      await responseCtx.sendInitial();

      const result = await state.runner.run(
        {
          chatId: message.chat.id,
          userText,
          ts: getMessageTimestamp(message),
          user: getUserHandle(message),
          userName: getUserName(message),
          onEvent: async (event) => {
            const label = getToolProgressLabel(event);
            if (!label) {
              return;
            }

            await responseCtx.updateProgress(label);
          }
        },
        state.store
      );

      if (result.stopReason === "aborted" || state.stopRequested) {
        await responseCtx.markStopped();
      } else {
        const finalText = result.reply.trim() !== "" ? result.reply : result.stopReason === "error" ? RUN_FAILED_REPLY : EMPTY_REPLY;
        await responseCtx.sendFinal(finalText);
      }

      logInfo("Handled message", {
        reason: decision.reason,
        chat_id: extracted.chatId,
        chat_type: extracted.chatType,
        message_id: extracted.messageId,
        from_id: extracted.fromId,
        content_type: extracted.contentType,
        explicit_only: chatPolicy.explicit_only,
        stop_reason: result.stopReason
      });
    } catch (error: unknown) {
      logError("Failed to handle Telegram message", error);
      await responseCtx.sendFinal(RUN_FAILED_REPLY);
    } finally {
      state.running = false;
      state.stopRequested = false;
    }
  });

  process.once("SIGINT", () => {
    bot.stop();
  });
  process.once("SIGTERM", () => {
    bot.stop();
  });

  logInfo("Telegram host started", {
    bot_name: botName,
    allowed_updates: "message"
  });
  await bot.start({ allowed_updates: ["message"] });

  return bot;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startTelegramHost().catch((error: unknown) => {
    logError("Telegram host failed to start", error);
    process.exitCode = 1;
  });
}
