import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

export interface TelegramSettings {
  proxy: string;
  explicit_only: boolean;
  allowed_chats: Record<string, ChatSettings>;
}

export interface AiSettings {
  proxy: string;
  provider: string;
  model: string;
}

export interface ChatSettings {
  explicit_only?: boolean;
}

export interface Settings {
  telegram: TelegramSettings;
  ai: AiSettings;
  sandbox: string;
}

export interface ChatPolicy {
  explicit_only: boolean;
}

const SETTINGS_FILENAME = "settings.json";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const fail = (path: string, message: string): never => {
  throw new Error(`Invalid settings: ${path} ${message}`);
};

const parseRequiredString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "must be a non-empty string");
  }

  return String(value);
};

const parseOptionalString = (value: unknown, path: string): string => {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    fail(path, "must be a string when provided");
  }

  return String(value);
};

const parseBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    fail(path, "must be a boolean");
  }

  return value === true;
};

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(path, "must be an object");
  }
}

export const loadSettings = async (): Promise<Settings> => {
  loadDotenv({ path: resolve(process.cwd(), ".env") });

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken || telegramToken.trim() === "") {
    throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
  }

  const settingsPath = resolve(process.cwd(), SETTINGS_FILENAME);

  let rawContent: string;
  try {
    rawContent = await readFile(settingsPath, "utf8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Settings file not found: ${SETTINGS_FILENAME}`);
    }

    throw new Error(`Failed to read ${SETTINGS_FILENAME}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error(`Invalid JSON in ${SETTINGS_FILENAME}`);
  }

  assertPlainObject(parsed, "$");
  const root = parsed;

  const telegramRaw = root.telegram;
  assertPlainObject(telegramRaw, "telegram");

  const proxy = parseOptionalString(telegramRaw.proxy, "telegram.proxy");
  const explicitOnly = parseBoolean(telegramRaw.explicit_only, "telegram.explicit_only");

  const allowedChatsRaw = telegramRaw.allowed_chats;
  assertPlainObject(allowedChatsRaw, "telegram.allowed_chats");

  const aiRaw = root.ai;
  assertPlainObject(aiRaw, "ai");
  const aiProxy = parseOptionalString(aiRaw.proxy, "ai.proxy");
  const provider = parseRequiredString(aiRaw.provider, "ai.provider");
  const model = parseRequiredString(aiRaw.model, "ai.model");

  const sandboxRaw = root.sandbox;
  const sandbox = parseRequiredString(sandboxRaw, "sandbox");
  if (sandbox !== "host" && !sandbox.startsWith("docker:")) {
    fail("sandbox", "must be either \"host\" or start with \"docker:\"");
  }

  const allowed_chats: Record<string, ChatSettings> = {};
  for (const [chatId, chatValue] of Object.entries(allowedChatsRaw)) {
    assertPlainObject(chatValue, `telegram.allowed_chats[${chatId}]`);
    const chatConfig = chatValue;

    const keys = Object.keys(chatConfig);
    const hasUnknownKeys = keys.some((key) => key !== "explicit_only");
    if (hasUnknownKeys) {
      fail(`telegram.allowed_chats[${chatId}]`, "may only contain explicit_only");
    }

    if (
      "explicit_only" in chatConfig &&
      typeof chatConfig.explicit_only !== "boolean"
    ) {
      fail(`telegram.allowed_chats[${chatId}].explicit_only`, "must be a boolean");
    }

    if (typeof chatConfig.explicit_only === "boolean") {
      allowed_chats[chatId] = {
        explicit_only: chatConfig.explicit_only
      };
      continue;
    }

    allowed_chats[chatId] = {};
  }

  return {
    telegram: {
      proxy,
      explicit_only: explicitOnly,
      allowed_chats
    },
    ai: {
      proxy: aiProxy,
      provider,
      model
    },
    sandbox
  };
};

export const getChatPolicy = (chatId: string | number | bigint, settings: Settings): ChatPolicy => {
  const chatOverride = settings.telegram.allowed_chats[String(chatId)];

  return {
    explicit_only: chatOverride?.explicit_only ?? settings.telegram.explicit_only
  };
};
