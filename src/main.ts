import { pathToFileURL } from "node:url";

import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import { logError, logInfo } from "./log.js";
import { getChatPolicy, loadSettings } from "./settings.js";
import {
  SYSTEM_COMMANDS,
  extractCommand,
  extractCommandForBot,
  extractMessageContent,
  formatDebugReply,
  formatHelpReply,
  formatStartReply,
  getMessageHandlingDecision,
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

export const startTelegramHost = async () => {
  const settings = await loadSettings();
  const proxyConfig = createProxyConfig(settings.telegram.proxy);

  logInfo("Initializing Telegram host", {
    explicit_only: settings.explicit_only,
    allowed_chats: Object.keys(settings.allowed_chats).length,
    proxy: proxyConfig.label
  });

  const bot = new Bot(settings.telegram.token, withOptionalProxyConfig(proxyConfig.agent));

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
      await ctx.reply(formatStartReply(message, botName));
      logInfo("Handled command", {
        command: command.commandName,
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        message_id: message.message_id
      });
      return;
    }

    if (command.commandName === "help") {
      await ctx.reply(formatHelpReply(botName));
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
    await ctx.reply(formatDebugReply(extracted));

    logInfo("Handled message", {
      reason: decision.reason,
      chat_id: extracted.chatId,
      chat_type: extracted.chatType,
      message_id: extracted.messageId,
      from_id: extracted.fromId,
      content_type: extracted.contentType,
      explicit_only: chatPolicy.explicit_only
    });
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
