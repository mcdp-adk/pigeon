import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUTH_PATH,
  createAuthStorage,
  getAuthStatus,
  isOAuthProvider,
  resolveAuthKind,
  resolveAuthPath,
  resolveAuthPathFromSettings
} from "../src/auth.js";

describe("auth", () => {
  describe("resolveAuthPath", () => {
    it("falls back to default when unset", () => {
      expect(resolveAuthPath()).toBe(DEFAULT_AUTH_PATH);
      expect(resolveAuthPath("")).toBe(DEFAULT_AUTH_PATH);
      expect(resolveAuthPath("   ")).toBe(DEFAULT_AUTH_PATH);
    });

    it("expands ~ and ~/... to homedir", () => {
      expect(resolveAuthPath("~")).toBe(homedir());
      expect(resolveAuthPath("~/.pi/custom.json")).toBe(join(homedir(), ".pi", "custom.json"));
    });

    it("resolves to absolute path", () => {
      const result = resolveAuthPath("relative.json");
      expect(result.endsWith("relative.json")).toBe(true);
      expect(result.startsWith("/") || /^[A-Z]:/.test(result)).toBe(true);
    });
  });

  describe("getAuthStatus", () => {
    let sandboxDir = "";

    beforeEach(async () => {
      sandboxDir = await mkdtemp(join(tmpdir(), "auth-test-"));
    });

    afterEach(async () => {
      if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
    });

    it("includes built-in OAuth providers even with empty auth.json", () => {
      const path = join(sandboxDir, "auth.json");
      const authStorage = createAuthStorage(path);
      const statuses = getAuthStatus(authStorage);

      const oauthCount = statuses.filter((s) => s.oauth).length;
      expect(oauthCount).toBeGreaterThan(0);
      expect(statuses.find((s) => s.provider === "anthropic")).toBeDefined();
    });

    it("includes every provider known to pi-ai (not just OAuth ones)", () => {
      const path = join(sandboxDir, "auth.json");
      const authStorage = createAuthStorage(path);
      const statuses = getAuthStatus(authStorage);

      const ids = new Set(statuses.map((s) => s.provider));
      expect(ids.has("openai")).toBe(true);
      expect(ids.has("mistral")).toBe(true);
      expect(ids.has("openrouter")).toBe(true);
      expect(ids.has("groq")).toBe(true);
    });

    it("shows env status for an env-only provider with no auth.json entry", () => {
      const path = join(sandboxDir, "auth.json");
      const authStorage = createAuthStorage(path);

      const original = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "env-only-key";
      try {
        const statuses = getAuthStatus(authStorage);
        const entry = statuses.find((s) => s.provider === "openrouter");
        expect(entry).toBeDefined();
        expect(entry?.kind).toBe("env");
        expect(entry?.oauth).toBe(false);
      } finally {
        if (original === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = original;
      }
    });

    it("marks api_key provider as api-key (highest precedence over env)", async () => {
      const path = join(sandboxDir, "auth.json");
      const authStorage = createAuthStorage(path);

      authStorage.set("openrouter", { type: "api_key", key: "sk-test" });
      const statuses = getAuthStatus(authStorage);

      const entry = statuses.find((s) => s.provider === "openrouter");
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("api-key");
      expect(entry?.oauth).toBe(false);
    });

    it("marks env-only provider as env when no stored credential", () => {
      const path = join(sandboxDir, "auth.json");
      const authStorage = createAuthStorage(path);
      const originalKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "env-key";
      try {
        expect(resolveAuthKind(authStorage, "openrouter")).toBe("env");
      } finally {
        if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = originalKey;
      }
    });
  });

  describe("isOAuthProvider", () => {
    it("returns true for built-in OAuth providers", () => {
      const authStorage = createAuthStorage(join(tmpdir(), `auth-${Date.now()}.json`));
      expect(isOAuthProvider(authStorage, "anthropic")).toBe(true);
      expect(isOAuthProvider(authStorage, "github-copilot")).toBe(true);
    });

    it("returns false for non-OAuth providers", () => {
      const authStorage = createAuthStorage(join(tmpdir(), `auth-${Date.now()}.json`));
      expect(isOAuthProvider(authStorage, "openrouter")).toBe(false);
      expect(isOAuthProvider(authStorage, "mistral")).toBe(false);
    });
  });

  describe("resolveAuthPathFromSettings", () => {
    let sandboxDir = "";
    const originalCwd = process.cwd();
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;

    beforeEach(async () => {
      sandboxDir = await mkdtemp(join(tmpdir(), "auth-settings-"));
      process.chdir(sandboxDir);
      delete process.env.TELEGRAM_BOT_TOKEN;
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;
      if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
    });

    it("does NOT require TELEGRAM_BOT_TOKEN (CLI must work without bot config)", async () => {
      await writeFile(
        "settings.json",
        JSON.stringify({
          telegram: { proxy: "", explicit_only: true, allowed_chats: {} },
          ai: { proxy: "", provider: "openai", model: "gpt-4o-mini" },
          sandbox: "host"
        }),
        "utf8"
      );

      await expect(resolveAuthPathFromSettings()).resolves.toBe(DEFAULT_AUTH_PATH);
    });

    it("returns the path from settings.ai.auth_path", async () => {
      await writeFile(
        "settings.json",
        JSON.stringify({
          telegram: { proxy: "", explicit_only: true, allowed_chats: {} },
          ai: { proxy: "", provider: "openai", model: "gpt-4o-mini", auth_path: "~/.pi/custom-pigeon.json" },
          sandbox: "host"
        }),
        "utf8"
      );

      await expect(resolveAuthPathFromSettings()).resolves.toBe(
        join(homedir(), ".pi", "custom-pigeon.json")
      );
    });
  });

  describe("AuthStorage persistence round-trip (sanity)", () => {
    let sandboxDir = "";

    beforeEach(async () => {
      sandboxDir = await mkdtemp(join(tmpdir(), "auth-persist-"));
    });

    afterEach(async () => {
      if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
    });

    it("persists api_key to disk and can be reloaded in a new instance", async () => {
      const path = join(sandboxDir, "auth.json");
      const first = createAuthStorage(path);
      first.set("openrouter", { type: "api_key", key: "sk-persisted" });

      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.openrouter).toEqual({ type: "api_key", key: "sk-persisted" });

      const second = createAuthStorage(path);
      expect(await second.getApiKey("openrouter")).toBe("sk-persisted");
    });

    it("reload() picks up external writes without recreating the instance", async () => {
      const path = join(sandboxDir, "auth.json");
      const storage = createAuthStorage(path);
      expect(await storage.getApiKey("openrouter")).toBeUndefined();

      const writer = createAuthStorage(path);
      writer.set("openrouter", { type: "api_key", key: "sk-external" });

      storage.reload();
      expect(await storage.getApiKey("openrouter")).toBe("sk-external");
    });
  });
});
