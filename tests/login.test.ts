import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAuthCli } from "../src/login.js";

describe("login CLI", () => {
  let sandboxDir = "";
  let customAuthPath = "";
  const originalCwd = process.cwd();
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  const stdoutOutput = (): string => {
    return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
  };

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "login-test-"));
    process.chdir(sandboxDir);
    customAuthPath = join(sandboxDir, "auth.json");
    delete process.env.TELEGRAM_BOT_TOKEN;

    await writeFile(
      "settings.json",
      JSON.stringify({
        telegram: { proxy: "", explicit_only: true, allowed_chats: {} },
        ai: {
          proxy: "",
          provider: "openrouter",
          model: "openai/gpt-4o-mini",
          auth_path: customAuthPath
        },
        sandbox: "host"
      }),
      "utf8"
    );

    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.chdir(originalCwd);
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
  });

  describe("status", () => {
    it("prints the auth path from settings.ai.auth_path", async () => {
      await runAuthCli(["status"]);
      expect(stdoutOutput()).toContain(customAuthPath);
    });

    it("includes every built-in OAuth provider", async () => {
      await runAuthCli(["status"]);
      const output = stdoutOutput();
      expect(output).toContain("anthropic");
      expect(output).toContain("github-copilot");
      expect(output).toContain("google-gemini-cli");
      expect(output).toContain("openai-codex");
    });

    it("includes stored non-OAuth providers from auth.json", async () => {
      await runAuthCli(["set", "openrouter", "sk-test"]);
      stdoutSpy.mockClear();

      await runAuthCli(["status"]);
      const output = stdoutOutput();
      expect(output).toContain("openrouter");
      expect(output).toContain("api-key");
    });
  });

  describe("set", () => {
    it("stores an API key via positional argument (no prompt)", async () => {
      await runAuthCli(["set", "openrouter", "sk-from-arg"]);

      const stored = JSON.parse(await readFile(customAuthPath, "utf8"));
      expect(stored.openrouter).toEqual({ type: "api_key", key: "sk-from-arg" });
    });

    it("rejects empty provider id", async () => {
      await expect(runAuthCli(["set"])).rejects.toThrow(/requires a provider id/);
    });

    it("rejects empty key when explicitly provided empty", async () => {
      await expect(runAuthCli(["set", "openrouter", ""])).rejects.toThrow(/empty/);
    });

    it("overwrites an existing key", async () => {
      await runAuthCli(["set", "openrouter", "sk-first"]);
      await runAuthCli(["set", "openrouter", "sk-second"]);

      const stored = JSON.parse(await readFile(customAuthPath, "utf8"));
      expect(stored.openrouter.key).toBe("sk-second");
    });
  });

  describe("logout / remove", () => {
    it("removes stored credentials", async () => {
      await runAuthCli(["set", "openrouter", "sk-delete-me"]);
      stdoutSpy.mockClear();

      await runAuthCli(["logout", "openrouter"]);
      const stored = JSON.parse(await readFile(customAuthPath, "utf8"));
      expect(stored.openrouter).toBeUndefined();
      expect(stdoutOutput()).toContain("Removed");
    });

    it("fails loudly for unknown provider (no silent success)", async () => {
      await expect(runAuthCli(["logout", "definitely-not-a-provider"])).rejects.toThrow(
        /No stored credentials/
      );
    });

    it("fails loudly when credential doesn't exist even if env-backed", async () => {
      const original = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "env-key";
      try {
        await expect(runAuthCli(["logout", "openrouter"])).rejects.toThrow(/No stored credentials/);
      } finally {
        if (original === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = original;
      }
    });

    it("remove is an alias for logout", async () => {
      await runAuthCli(["set", "openrouter", "sk-foo"]);
      stdoutSpy.mockClear();

      await runAuthCli(["remove", "openrouter"]);
      const stored = JSON.parse(await readFile(customAuthPath, "utf8"));
      expect(stored.openrouter).toBeUndefined();
    });

    it("requires a provider id", async () => {
      await expect(runAuthCli(["logout"])).rejects.toThrow(/requires a provider id/);
    });
  });

  describe("login", () => {
    it("rejects login for non-OAuth provider", async () => {
      await expect(runAuthCli(["login", "openrouter"])).rejects.toThrow(/not an OAuth provider/);
    });

    it("rejects unknown provider id", async () => {
      await expect(runAuthCli(["login", "nope-not-real"])).rejects.toThrow(/not an OAuth provider/);
    });
  });

  describe("parseArgs", () => {
    it("rejects unknown command", async () => {
      await expect(runAuthCli(["garbage"])).rejects.toThrow(/Unknown command/);
    });
  });

  describe("uses unified path resolution", () => {
    it("reads the same file the bot would use (via settings.ai.auth_path)", async () => {
      await runAuthCli(["set", "openrouter", "sk-unified"]);

      const raw = await readFile(customAuthPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.openrouter.key).toBe("sk-unified");
    });
  });

  describe("stdin fallback (non-TTY interactive set)", () => {
    it("reads the key from piped stdin when no inline key is given", async () => {
      const { Readable } = await import("node:stream");
      const pipe = new Readable({ read() {} });
      pipe.push("sk-from-stdin\n");
      pipe.push(null);

      const originalStdin = process.stdin;
      Object.defineProperty(process, "stdin", { value: pipe, configurable: true });
      try {
        await runAuthCli(["set", "openrouter"]);
      } finally {
        Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
      }

      const parsed = JSON.parse(await readFile(customAuthPath, "utf8"));
      expect(parsed.openrouter.key).toBe("sk-from-stdin");
    });
  });
});
