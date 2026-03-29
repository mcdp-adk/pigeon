import { pathToFileURL } from "node:url";

import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import { getChatPolicy, loadSettings } from "./settings.js";
import {
  extractMessageContent,
  formatDebugReply,
  formatStartReply,
  isStartCommand,
  shouldHandleMessage,
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

const createProxyAgent = (proxy: string) => {
  const trimmedProxy = proxy.trim();
  if (trimmedProxy === "") {
    return undefined;
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(trimmedProxy);
  } catch {
    throw new Error("Invalid telegram.proxy URL");
  }

  const protocol = proxyUrl.protocol;

  if (protocol === "http:" || protocol === "https:") {
    return new HttpsProxyAgent(trimmedProxy);
  }

  if (protocol === "socks5:" || protocol === "socks5h:") {
    const normalizedProxy = protocol === "socks5:" ? `socks5h://${proxyUrl.host}` : trimmedProxy;
    return new SocksProxyAgent(normalizedProxy);
  }

  throw new Error(`Unsupported telegram.proxy protocol: ${protocol}`);
};

const withOptionalProxyConfig = (proxy: string) => {
  const proxyAgent = createProxyAgent(proxy);
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
  const bot = new Bot(settings.telegram.token, withOptionalProxyConfig(settings.telegram.proxy));

  await bot.init();
  const botInfo = bot.botInfo;
  if (!botInfo) {
    throw new Error("Bot info is not available after init");
  }

  const botName = botInfo.username ?? botInfo.first_name;

  bot.on("message", async (ctx) => {
    if (!isTelegramMessage(ctx.message)) {
      return;
    }

    const message = ctx.message;

    if (isStartCommand(message)) {
      await ctx.reply(formatStartReply(message, botName));
      return;
    }

    const chatPolicy = getChatPolicy(message.chat.id, settings);
    const shouldHandle = shouldHandleMessage(message, {
      explicitOnly: chatPolicy.explicit_only,
      allowedChats: settings.allowed_chats,
      botId: botInfo.id,
      botUsername: botInfo.username
    });

    if (!shouldHandle) {
      return;
    }

    const extracted = extractMessageContent(message);
    await ctx.reply(formatDebugReply(extracted));
  });

  process.once("SIGINT", () => {
    bot.stop();
  });
  process.once("SIGTERM", () => {
    bot.stop();
  });

  console.log("Telegram host started");
  await bot.start({ allowed_updates: ["message"] });

  return bot;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startTelegramHost().catch((error: unknown) => {
    console.error("Telegram host failed to start", error);
    process.exitCode = 1;
  });
}
