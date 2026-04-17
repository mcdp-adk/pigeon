import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import type { AuthStorage } from "@mariozechner/pi-coding-agent";

import {
  createAuthStorage,
  getAuthStatus,
  isOAuthProvider,
  resolveAuthKind,
  resolveAuthPathFromSettings
} from "./auth.js";

type Command = "login" | "logout" | "status" | "set" | "remove" | "models";

interface ParsedArgs {
  command: Command;
  positional: string[];
}

const USAGE = `Usage:
  npm run login                            Interactive OAuth login (pick a provider)
  npm run login <provider>                 OAuth login for a specific provider
  npm run logout <provider>                Remove stored credentials for a provider
  npm run auth:status                      List credential status for every known provider
  npm run auth:set <provider> [<key>]      Store or update an API key (prompts if omitted)
  npm run auth:remove <provider>           Alias for logout
  npm run models [<provider>]              List legal ai.provider / ai.model values

Credential file: resolved from settings.ai.auth_path (default ~/.pi/pigeon/auth.json).
`;

const COMMANDS = new Set<Command>(["login", "logout", "status", "set", "remove", "models"]);

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const [rawCommand, ...rest] = argv;
  const command = (rawCommand ?? "login") as Command;
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${rawCommand}\n\n${USAGE}`);
  }
  return { command, positional: rest.filter((arg) => !arg.startsWith("-")) };
};

const openPrompter = () => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (message: string) => (await rl.question(message)).trim(),
    close: () => rl.close()
  };
};

const askSecret = async (message: string): Promise<string> => {
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  process.stdout.write(message);
  const isTTY = stdin.isTTY === true && typeof stdin.setRawMode === "function";
  if (!isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try {
      const answer = await rl.question("");
      return answer.trim();
    } finally {
      rl.close();
    }
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let buffer = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolvePromise(buffer.trim());
          return;
        }
        if (code === 3) {
          cleanup();
          rejectPromise(new Error("aborted"));
          return;
        }
        if (code === 127 || code === 8) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (code < 32) continue;
        buffer += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
};

const openAuthStorage = async (): Promise<AuthStorage> => {
  const path = await resolveAuthPathFromSettings();
  return createAuthStorage(path);
};

const selectOAuthProvider = async (
  authStorage: AuthStorage,
  prompter: { ask: (message: string) => Promise<string> }
): Promise<string> => {
  const providers = authStorage.getOAuthProviders();
  if (providers.length === 0) throw new Error("No OAuth providers are registered");

  process.stdout.write("Available OAuth providers:\n");
  providers.forEach((p, index) => {
    process.stdout.write(`  ${index + 1}. ${p.name} (${p.id})\n`);
  });
  const answer = await prompter.ask("Select a provider (number or id): ");
  if (answer === "") throw new Error("No provider selected");

  const n = Number.parseInt(answer, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= providers.length) {
    return providers[n - 1].id;
  }
  const match = providers.find((p) => p.id === answer);
  if (!match) throw new Error(`Unknown OAuth provider: ${answer}`);
  return match.id;
};

const runLogin = async (provider: string | undefined): Promise<void> => {
  const authStorage = await openAuthStorage();
  const prompter = openPrompter();
  try {
    const providerId = provider ?? await selectOAuthProvider(authStorage, prompter);
    if (!isOAuthProvider(authStorage, providerId)) {
      throw new Error(
        `"${providerId}" is not an OAuth provider. Use "npm run auth:set ${providerId}" to store an API key.`
      );
    }

    process.stdout.write(`\nStarting OAuth flow for ${providerId}...\n`);
    await authStorage.login(providerId, {
      onAuth: ({ url, instructions }) => {
        process.stdout.write(`\nOpen this URL in your browser:\n  ${url}\n`);
        if (instructions) process.stdout.write(`${instructions}\n`);
      },
      onPrompt: async ({ message }) => prompter.ask(`${message}: `),
      onProgress: (message) => process.stdout.write(`${message}\n`),
      onManualCodeInput: async () => prompter.ask("Paste the authorization code: ")
    });

    const path = await resolveAuthPathFromSettings();
    process.stdout.write(`\nLogged in to ${providerId}. Credentials saved to ${path}\n`);
  } finally {
    prompter.close();
  }
};

const runLogout = async (provider: string | undefined): Promise<void> => {
  if (!provider) throw new Error(`logout requires a provider id\n\n${USAGE}`);
  const authStorage = await openAuthStorage();
  const existing = authStorage.get(provider);
  if (!existing) {
    throw new Error(
      `No stored credentials for "${provider}". Current status: ${resolveAuthKind(authStorage, provider)}.`
    );
  }
  authStorage.logout(provider);
  process.stdout.write(`Removed ${existing.type === "oauth" ? "OAuth token" : "API key"} for ${provider}\n`);
};

const runSet = async (args: readonly string[]): Promise<void> => {
  const [provider, inlineKey] = args;
  if (!provider) throw new Error(`set requires a provider id\n\n${USAGE}`);

  const authStorage = await openAuthStorage();
  if (isOAuthProvider(authStorage, provider) && inlineKey === undefined) {
    process.stdout.write(
      `Note: "${provider}" supports OAuth. Use "npm run login ${provider}" for a subscription login, ` +
      `or continue to store a static API key.\n`
    );
  }

  if (inlineKey === "") throw new Error("API key is empty");

  let key = inlineKey ?? "";
  if (key === "") {
    key = await askSecret(`API key for ${provider} (input hidden): `);
  }
  if (key === "") throw new Error("API key is empty");

  authStorage.set(provider, { type: "api_key", key });
  const path = await resolveAuthPathFromSettings();
  process.stdout.write(`Stored API key for ${provider} in ${path}\n`);
};

const runStatus = async (): Promise<void> => {
  const path = await resolveAuthPathFromSettings();
  const authStorage = createAuthStorage(path);
  const statuses = getAuthStatus(authStorage);
  process.stdout.write(`Auth file: ${path}\n\n`);

  if (statuses.length === 0) {
    process.stdout.write("No providers registered.\n");
    return;
  }

  const idW = Math.max(...statuses.map((s) => s.provider.length), 8);
  const nameW = Math.max(...statuses.map((s) => s.name.length), 4);
  const kindW = 8;
  const pad = (v: string, w: number) => v.padEnd(w);
  process.stdout.write(`${pad("id", idW)}  ${pad("name", nameW)}  ${pad("status", kindW)}  oauth\n`);
  for (const s of statuses) {
    process.stdout.write(
      `${pad(s.provider, idW)}  ${pad(s.name, nameW)}  ${pad(s.kind, kindW)}  ${s.oauth ? "yes" : "no"}\n`
    );
  }
};

const runModels = async (filterProvider: string | undefined): Promise<void> => {
  const { getProviders, getModels } = await import("@mariozechner/pi-ai");
  const providers = filterProvider ? [filterProvider] : [...getProviders()].sort();
  for (const provider of providers) {
    const models = getModels(provider as Parameters<typeof getModels>[0]);
    if (!models || models.length === 0) {
      if (filterProvider) throw new Error(`Unknown provider "${provider}"`);
      continue;
    }
    process.stdout.write(`\n${provider}\n`);
    for (const model of models.slice().sort((a, b) => a.id.localeCompare(b.id))) {
      process.stdout.write(`  ${model.id}\n`);
    }
  }
};

export const runAuthCli = async (argv: readonly string[]): Promise<void> => {
  const { command, positional } = parseArgs(argv);
  if (command === "login") return runLogin(positional[0]);
  if (command === "logout" || command === "remove") return runLogout(positional[0]);
  if (command === "status") return runStatus();
  if (command === "set") return runSet(positional);
  if (command === "models") return runModels(positional[0]);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuthCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
