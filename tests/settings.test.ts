import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChatPolicy, loadSettings } from "../src/settings.js";

describe("settings", () => {
  let sandboxDir = "";
  const originalCwd = process.cwd();
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "settings-test-"));
    process.chdir(sandboxDir);

    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  });

  afterEach(async () => {
    process.chdir(originalCwd);

    if (originalTelegramToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
    }

    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  const writeSettingsJson = async (value: unknown) => {
    await writeFile("settings.json", JSON.stringify(value, null, 2), "utf8");
  };

  it("loads valid settings and keeps empty proxy", async () => {
    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": {},
          "-1002": { explicit_only: false }
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).resolves.toEqual({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": {},
          "-1002": { explicit_only: false }
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });
  });

  it("loads settings when top-level $schema is present", async () => {
    await writeSettingsJson({
      $schema: "./settings.schema.json",
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": {}
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "docker:default"
    });

    await expect(loadSettings()).resolves.toEqual({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": {}
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "docker:default"
    });
  });

  it("throws clear error when settings.json is missing", async () => {
    await expect(loadSettings()).rejects.toThrow(/settings\.json/i);
    await expect(loadSettings()).rejects.toThrow(/not found|missing/i);
  });

  it("throws clear error on invalid JSON", async () => {
    await writeFile("settings.json", "{bad json", "utf8");

    await expect(loadSettings()).rejects.toThrow(/invalid json/i);
  });

  it("throws clear error when TELEGRAM_BOT_TOKEN env var is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {}
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).rejects.toThrow(/TELEGRAM_BOT_TOKEN/i);
  });

  it("loads TELEGRAM_BOT_TOKEN from cwd .env when process env is empty", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    await writeFile(
      ".env",
      "TELEGRAM_BOT_TOKEN=from-dotenv\n",
      "utf8"
    );

    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {}
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).resolves.toEqual({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {}
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("from-dotenv");
  });

  it("requires telegram.explicit_only to be boolean", async () => {
    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: "true",
        allowed_chats: {}
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).rejects.toThrow(/telegram\.explicit_only|explicit_only/i);
    await expect(loadSettings()).rejects.toThrow(/boolean/i);
  });

  it("requires telegram.allowed_chats to be an object", async () => {
    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: []
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).rejects.toThrow(/telegram\.allowed_chats|allowed_chats/i);
    await expect(loadSettings()).rejects.toThrow(/object/i);
  });

  it("rejects invalid per-chat policy payload", async () => {
    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": { explicit_only: "yes" }
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).rejects.toThrow(/telegram\.allowed_chats\[-1001\]/i);
    await expect(loadSettings()).rejects.toThrow(/explicit_only.*boolean/i);
  });

  it("rejects unknown keys in per-chat policy", async () => {
    await writeSettingsJson({
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": { extra: true }
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    });

    await expect(loadSettings()).rejects.toThrow(/telegram\.allowed_chats\[-1001\]/i);
    await expect(loadSettings()).rejects.toThrow(/only.*explicit_only|unsupported/i);
  });

  it("resolves chat policy with String(chatId), global default and override", () => {
    const settings = {
      telegram: {
        proxy: "",
        explicit_only: true,
        allowed_chats: {
          "-1001": {},
          "-1002": { explicit_only: false }
        }
      },
      ai: { provider: "openai", model: "gpt-4o-mini" },
      sandbox: "host"
    };

    expect(getChatPolicy(-1001, settings).explicit_only).toBe(true);
    expect(getChatPolicy(-1002, settings).explicit_only).toBe(false);
    expect(getChatPolicy("-1003", settings).explicit_only).toBe(true);
  });
});
