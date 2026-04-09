import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import { getOrCreateRunner, type AgentRunner, type AgentRunEvent } from "./agent.js";
import { createEventsWatcher } from "./events.js";
import { logError, logInfo, logWarning } from "./log.js";
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
  splitText,
  type TelegramResponseContext,
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

const EVENT_QUEUE_MAX = 5;

class EventQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  enqueue(work: () => Promise<void>): boolean {
    if (this.queue.length >= EVENT_QUEUE_MAX) {
      return false;
    }
    this.queue.push(work);
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        await this.queue.shift()!();
      }
    } finally {
      this.processing = false;
    }
  }
}

interface ChatState {
  running: boolean;
  stopRequested: boolean;
  runner: AgentRunner;
  store: ChatStore;
  responseCtx?: TelegramResponseContext;
  eventQueue: EventQueue;
}

const DATA_DIR = resolve(process.cwd(), "data");
const BUSY_REPLY = "<b>⏳ 正在处理上一条消息</b>\n\n请稍候，或发送 /stop 取消当前任务。";
const UNSUPPORTED_TEXT_REPLY = "<b>⚠️ 无法处理此消息</b>\n\n仅支持纯文字消息，请发送文字内容。";
const RUN_FAILED_REPLY = "<b>❌ 处理失败</b>\n\n任务执行时出错，请稍后重试。";
const EMPTY_REPLY = "<b>ℹ️ 无回复内容</b>";

const chatStates = new Map<string, ChatState>();

type SystemCommandName = (typeof SYSTEM_COMMANDS)[number]["command"];

const isSystemCommandName = (value: string | undefined): value is SystemCommandName => {
  return SYSTEM_COMMANDS.some((command) => command.command === value);
};

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
    store,
    responseCtx: undefined,
    eventQueue: new EventQueue()
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

async function dispatchSystemCommand(params: {
  commandName: string | undefined;
  message: TelegramMessage;
  ctx: Context;
  botName: string;
  settings: Settings;
}): Promise<boolean> {
  const { commandName, message, ctx, botName, settings } = params;
  if (!isSystemCommandName(commandName)) {
    return false;
  }

  if (commandName === "start") {
    const isAuthorized = isChatAllowed(message.chat.id, settings.telegram.allowed_chats);
    await sendTelegramReply(formatStartReply(message, botName, isAuthorized), ctx.reply.bind(ctx));
    logInfo("Handled command", {
      command: commandName,
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      message_id: message.message_id
    });
    return true;
  }

  if (commandName === "stop") {
    const state = getOrCreateChatState(message.chat.id, settings);
    if (!state.running) {
      await ctx.reply("<b>ℹ️ 没有正在运行的任务</b>", { parse_mode: "HTML" });
      logInfo("Handled command", {
        command: commandName,
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        message_id: message.message_id,
        result: "idle"
      });
      return true;
    }

    state.stopRequested = true;
    state.runner.abort();

    if (state.responseCtx) {
      await state.responseCtx.markStopped();
    }
    logInfo("Handled command", {
      command: commandName,
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      message_id: message.message_id,
      result: "stopped"
    });
    return true;
  }

  await sendTelegramReply(formatHelpReply(botName), ctx.reply.bind(ctx));
  logInfo("Handled command", {
    command: commandName,
    chat_id: message.chat.id,
    chat_type: message.chat.type,
    message_id: message.message_id
  });
  return true;
}

const getToolProgressLabel = (event: AgentRunEvent): string | undefined => {
  if (event.type === "tool_start") {
    return `调用工具：${event.label}`;
  }
  if (event.type === "tool_end") {
    return event.isError ? `工具失败：${event.label}` : `工具完成：${event.label}`;
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
    explicit_only: settings.telegram.explicit_only,
    allowed_chats: Object.keys(settings.telegram.allowed_chats).length,
    proxy: proxyConfig.label
  });

  mkdirSync(DATA_DIR, { recursive: true });
  const bot = new Bot(telegramToken, withOptionalProxyConfig(proxyConfig.agent));
  const activeRuns = new Set<Promise<void>>();

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

    if (await dispatchSystemCommand({ commandName: command.commandName, message, ctx, botName, settings })) {
      return;
    }

    const chatPolicy = getChatPolicy(message.chat.id, settings);
    const decision = getMessageHandlingDecision(message, {
      explicitOnly: chatPolicy.explicit_only,
      allowedChats: settings.telegram.allowed_chats,
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
      await ctx.reply(UNSUPPORTED_TEXT_REPLY, { parse_mode: "HTML" });
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
      await ctx.reply(BUSY_REPLY, { parse_mode: "HTML" });
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
    state.responseCtx = responseCtx;

    const runInput = {
      chatId: message.chat.id,
      userText,
      ts: getMessageTimestamp(message),
      user: getUserHandle(message),
      userName: getUserName(message),
      onEvent: async (event: AgentRunEvent) => {
        if (event.type === "text_delta") {
          await responseCtx.appendDelta(event.delta);
          return;
        }
        const label = getToolProgressLabel(event);
        if (label) {
          await responseCtx.updateProgress(label);
        }
      }
    };

    const logMeta = {
      reason: decision.reason,
      chat_id: extracted.chatId,
      chat_type: extracted.chatType,
      message_id: extracted.messageId,
      from_id: extracted.fromId,
      content_type: extracted.contentType,
      explicit_only: chatPolicy.explicit_only,
    };

    let runPromise!: Promise<void>;
    runPromise = (async () => {
      try {
        await responseCtx.sendInitial();

        const result = await state.runner.run(runInput, state.store);

        if (result.stopReason === "aborted" || state.stopRequested) {
          await responseCtx.markStopped();
        } else {
          const finalText = result.reply.trim() !== "" ? result.reply : result.stopReason === "error" ? RUN_FAILED_REPLY : EMPTY_REPLY;
          await responseCtx.sendFinal(finalText);
        }

        logInfo("Handled message", { ...logMeta, stop_reason: result.stopReason });
      } catch (error: unknown) {
        logError("Failed to handle Telegram message", error);
        await responseCtx.sendFinal(RUN_FAILED_REPLY);
      } finally {
        state.running = false;
        state.stopRequested = false;
        state.responseCtx = undefined;
        activeRuns.delete(runPromise);
      }
    })();

    activeRuns.add(runPromise);
  });

  const SILENT_MARKER = "[SILENT]";

  const runEventForChat = async (state: ChatState, chatId: string, text: string): Promise<void> => {
    const ts = String(Date.now());
    state.running = true;
    state.stopRequested = false;

    try {
      const result = await state.runner.run(
        { chatId: Number(chatId), userText: text, ts, user: "EVENT" },
        state.store
      );
      logInfo("Event run completed", { chat_id: chatId, stop_reason: result.stopReason });

      const reply = result.reply.trim();
      if (reply !== "" && reply !== SILENT_MARKER) {
        for (const part of splitText(reply)) {
          await bot.api.sendMessage(Number(chatId), part, { parse_mode: "HTML" });
        }
      }
    } catch (error: unknown) {
      logError("Event run failed", error);
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.responseCtx = undefined;
    }
  };

  const fireEventForChat = ({ chatId, text }: { chatId: string; text: string }): void => {
    if (!isChatAllowed(Number(chatId), settings.telegram.allowed_chats)) {
      logWarning("Event fired for unauthorized chat, discarding", { chat_id: chatId });
      return;
    }

    const state = getOrCreateChatState(Number(chatId), settings);
    const enqueued = state.eventQueue.enqueue(() => runEventForChat(state, chatId, text));
    if (!enqueued) {
      logWarning("Event queue full, discarding", { chat_id: chatId });
    }
  };

  const eventsWatcher = createEventsWatcher(DATA_DIR, fireEventForChat);
  eventsWatcher.start();

  const shutdown = async () => {
    eventsWatcher.stop();
    bot.stop();
    for (const [, state] of chatStates) {
      if (state.running) {
        state.runner.abort();
      }
    }
    await Promise.race([
      Promise.allSettled([...activeRuns]),
      new Promise<void>((resolve) => setTimeout(resolve, 8000))
    ]);
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

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
