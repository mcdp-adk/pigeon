import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChatPolicy, loadSettings } from "../src/settings.js";

describe("settings", () => {
  let sandboxDir = "";
  const originalCwd = process.cwd();

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "settings-test-"));
    process.chdir(sandboxDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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
        token: "bot-token",
        proxy: ""
      },
      explicit_only: true,
      allowed_chats: {
        "-1001": {},
        "-1002": { explicit_only: false }
      }
    });

    await expect(loadSettings()).resolves.toEqual({
      telegram: {
        token: "bot-token",
        proxy: ""
      },
      explicit_only: true,
      allowed_chats: {
        "-1001": {},
        "-1002": { explicit_only: false }
      }
    });
  });

  it("loads settings when top-level $schema is present", async () => {
    await writeSettingsJson({
      $schema: "./settings.schema.json",
      telegram: {
        token: "bot-token",
        proxy: ""
      },
      explicit_only: true,
      allowed_chats: {
        "-1001": {}
      }
    });

    await expect(loadSettings()).resolves.toEqual({
      telegram: {
        token: "bot-token",
        proxy: ""
      },
      explicit_only: true,
      allowed_chats: {
        "-1001": {}
      }
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

  it("throws clear error when token is missing", async () => {
    await writeSettingsJson({
      telegram: {},
      explicit_only: true,
      allowed_chats: {}
    });

    await expect(loadSettings()).rejects.toThrow(/telegram\.token/i);
  });

  it("requires top-level explicit_only to be boolean", async () => {
    await writeSettingsJson({
      telegram: { token: "bot-token", proxy: "" },
      explicit_only: "true",
      allowed_chats: {}
    });

    await expect(loadSettings()).rejects.toThrow(/explicit_only/i);
    await expect(loadSettings()).rejects.toThrow(/boolean/i);
  });

  it("requires allowed_chats to be an object", async () => {
    await writeSettingsJson({
      telegram: { token: "bot-token", proxy: "" },
      explicit_only: true,
      allowed_chats: []
    });

    await expect(loadSettings()).rejects.toThrow(/allowed_chats/i);
    await expect(loadSettings()).rejects.toThrow(/object/i);
  });

  it("rejects invalid per-chat policy payload", async () => {
    await writeSettingsJson({
      telegram: { token: "bot-token", proxy: "" },
      explicit_only: true,
      allowed_chats: {
        "-1001": { explicit_only: "yes" }
      }
    });

    await expect(loadSettings()).rejects.toThrow(/allowed_chats\[-1001\]/i);
    await expect(loadSettings()).rejects.toThrow(/explicit_only.*boolean/i);
  });

  it("rejects unknown keys in per-chat policy", async () => {
    await writeSettingsJson({
      telegram: { token: "bot-token", proxy: "" },
      explicit_only: true,
      allowed_chats: {
        "-1001": { extra: true }
      }
    });

    await expect(loadSettings()).rejects.toThrow(/allowed_chats\[-1001\]/i);
    await expect(loadSettings()).rejects.toThrow(/only.*explicit_only|unsupported/i);
  });

  it("resolves chat policy with String(chatId), global default and override", () => {
    const settings = {
      telegram: { token: "bot-token", proxy: "" },
      explicit_only: true,
      allowed_chats: {
        "-1001": {},
        "-1002": { explicit_only: false }
      }
    };

    expect(getChatPolicy(-1001, settings).explicit_only).toBe(true);
    expect(getChatPolicy(-1002, settings).explicit_only).toBe(false);
    expect(getChatPolicy("-1003", settings).explicit_only).toBe(true);
  });
});
