import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";

export interface Attachment {
	original: string;
	local: string;
}

export interface LoggedMessage {
	date: string;
	ts: string;
	user: string;
	userName?: string;
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChatStoreConfig {
	workingDir: string;
}

export class ChatStore {
	private workingDir: string;
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChatStoreConfig) {
		this.workingDir = config.workingDir;

		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	getChatDir(chatId: string): string {
		const dir = join(this.workingDir, `chat-${chatId}`);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	private toIsoDateFromEpochMs(ts: string): string | null {
		const parsed = Number.parseInt(ts, 10);
		if (!Number.isFinite(parsed)) return null;
		return new Date(parsed).toISOString();
	}

	async logMessage(chatId: string, message: LoggedMessage): Promise<boolean> {
		const dedupeKey = `${chatId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false;
		}

		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChatDir(chatId), "log.jsonl");

		let date = message.date;
		if (!date) {
			const computed = this.toIsoDateFromEpochMs(message.ts);
			if (computed) {
				date = computed;
			}
		}

		const persisted: LoggedMessage = {
			...message,
			date,
			attachments: []
		};

		const line = `${JSON.stringify(persisted)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	async logBotResponse(chatId: string, text: string, ts: string): Promise<void> {
		const date = this.toIsoDateFromEpochMs(ts) ?? new Date().toISOString();
		await this.logMessage(chatId, {
			date,
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true
		});
	}

	getLastTimestamp(chatId: string): string | null {
		const logPath = join(this.workingDir, `chat-${chatId}`, "log.jsonl");
		if (!existsSync(logPath)) {
			return null;
		}

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") {
				return null;
			}

			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}
}
