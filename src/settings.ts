import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface TelegramSettings {
  token: string;
  proxy: string;
}

export interface ChatSettings {
  explicit_only?: boolean;
}

export interface Settings {
  telegram: TelegramSettings;
  explicit_only: boolean;
  allowed_chats: Record<string, ChatSettings>;
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

  const token = parseRequiredString(telegramRaw.token, "telegram.token");
  const proxy = parseOptionalString(telegramRaw.proxy, "telegram.proxy");
  const explicitOnly = parseBoolean(root.explicit_only, "explicit_only");

  const allowedChatsRaw = root.allowed_chats;
  assertPlainObject(allowedChatsRaw, "allowed_chats");

  const allowed_chats: Record<string, ChatSettings> = {};
  for (const [chatId, chatValue] of Object.entries(allowedChatsRaw)) {
    assertPlainObject(chatValue, `allowed_chats[${chatId}]`);
    const chatConfig = chatValue;

    const keys = Object.keys(chatConfig);
    const hasUnknownKeys = keys.some((key) => key !== "explicit_only");
    if (hasUnknownKeys) {
      fail(`allowed_chats[${chatId}]`, "may only contain explicit_only");
    }

    if (
      "explicit_only" in chatConfig &&
      typeof chatConfig.explicit_only !== "boolean"
    ) {
      fail(`allowed_chats[${chatId}].explicit_only`, "must be a boolean");
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
      token,
      proxy
    },
    explicit_only: explicitOnly,
    allowed_chats
  };
};

export const getChatPolicy = (chatId: string | number | bigint, settings: Settings): ChatPolicy => {
  const chatOverride = settings.allowed_chats[String(chatId)];

  return {
    explicit_only: chatOverride?.explicit_only ?? settings.explicit_only
  };
};
