import { pathToFileURL } from "node:url";

import { Bot } from "grammy";
import { ProxyAgent } from "proxy-agent";

import { getChatPolicy, loadSettings } from "./settings.js";
import {
  extractMessageContent,
  formatDebugReply,
  formatStartReply,
  isStartCommand,
  shouldHandleMessage,
  type TelegramMessage
} from "./telegram.js";

const withOptionalProxyConfig = (proxy: string) => {
  if (proxy.trim() === "") {
    return undefined;
  }

  const proxyAgent = new ProxyAgent({
    getProxyForUrl: () => proxy
  });

  return {
    client: {
      baseFetchConfig: {
        agent: proxyAgent
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
    const message = ctx.message as unknown as TelegramMessage;

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
