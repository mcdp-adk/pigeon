import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { UserMessage } from "@mariozechner/pi-ai";
import { type SessionManager, type SessionMessageEntry, SettingsManager } from "@mariozechner/pi-coding-agent";

import { type LoggedMessage } from "./store.js";

type LogMessage = Partial<LoggedMessage>;
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	chatDir: string,
	excludeTs?: string,
): number {
	const logFile = join(chatDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const msg = msgEntry.message as { role: string; content?: unknown };
		if (msg.role !== "user" || msg.content === undefined) continue;

		const content = msg.content;
		if (typeof content === "string") {
			let normalized = content.replace(
				/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /,
				"",
			);
			const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
			if (attachmentsIdx !== -1) {
				normalized = normalized.substring(0, attachmentsIdx);
			}
			existingMessages.add(normalized);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					(part as { type: string }).type === "text" &&
					"text" in part
				) {
					let normalized = (part as { type: "text"; text: string }).text;
					normalized = normalized.replace(
						/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /,
						"",
					);
					const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				}
			}
		}
	}

	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			if (excludeTs && slackTs === excludeTs) continue;
			if (logMsg.isBot) continue;
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText);
		} catch {
		}
	}

	if (newMessages.length === 0) return 0;

	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

type PigeonSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements PigeonSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "agent-runtime.json");
	}

	withLock(
		scope: "global" | "project",
		fn: (current: string | undefined) => string | undefined,
	): void {
		if (scope === "project") {
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath)
			? readFileSync(this.settingsPath, "utf-8")
			: undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createPigeonSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}
