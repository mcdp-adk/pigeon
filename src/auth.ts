import { homedir } from "node:os";
import { resolve } from "node:path";

import { getEnvApiKey, getProviders } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

import { loadSettingsFile } from "./settings.js";

export type AuthKind = "api-key" | "oauth" | "env" | "none";

export interface AuthStatus {
  provider: string;
  name: string;
  kind: AuthKind;
  oauth: boolean;
}

/**
 * Default credential store location for pigeon.
 *
 * Isolating pigeon's credentials from other pi tools (e.g. the pi coding agent)
 * is the right default: Telegram is a very different surface than a local
 * terminal, and a user may want the bot to use different accounts/subscriptions.
 * Users who want to share can point `ai.auth_path` at another file.
 */
export const DEFAULT_AUTH_PATH = resolve(homedir(), ".pi", "pigeon", "auth.json");

const expandHome = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
};

export const resolveAuthPath = (configured?: string): string => {
  const candidate = (configured ?? "").trim();
  if (candidate === "") return DEFAULT_AUTH_PATH;
  return resolve(expandHome(candidate));
};

export const createAuthStorage = (configured?: string): AuthStorage => {
  return AuthStorage.create(resolveAuthPath(configured));
};

/**
 * Single source of truth for which auth.json pigeon uses. Used by BOTH
 * the running bot and the credential CLI, so they always agree.
 */
export const resolveAuthPathFromSettings = async (): Promise<string> => {
  const settings = await loadSettingsFile();
  return resolveAuthPath(settings.ai.auth_path);
};

export const resolveAuthKind = (authStorage: AuthStorage, providerId: string): AuthKind => {
  const credential = authStorage.get(providerId);
  if (credential?.type === "api_key") return "api-key";
  if (credential?.type === "oauth") return "oauth";
  if (getEnvApiKey(providerId) !== undefined) return "env";
  return "none";
};

export const isOAuthProvider = (authStorage: AuthStorage, providerId: string): boolean => {
  return authStorage.getOAuthProviders().some((p) => p.id === providerId);
};

/**
 * Enumerate every provider pigeon can authenticate against: every provider
 * known to pi-ai, every OAuth-capable provider, and every id already stored
 * in auth.json. This gives a truthful cross-source status view.
 */
export const getAuthStatus = (authStorage: AuthStorage): AuthStatus[] => {
  const oauth = new Map<string, string>();
  for (const p of authStorage.getOAuthProviders()) oauth.set(p.id, p.name);

  const ids = new Set<string>(getProviders());
  for (const id of oauth.keys()) ids.add(id);
  for (const id of authStorage.list()) ids.add(id);

  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      provider: id,
      name: oauth.get(id) ?? id,
      kind: resolveAuthKind(authStorage, id),
      oauth: oauth.has(id)
    }));
};
