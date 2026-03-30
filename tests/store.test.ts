import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChatStore } from "../src/store.js";

describe("store", () => {
	let sandboxDir = "";
	let dataDir = "";

	afterEach(async () => {
		if (sandboxDir) {
			await rm(sandboxDir, { recursive: true, force: true });
		}
	});

	it("appends log.jsonl and returns last timestamp", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "store-test-"));
		dataDir = join(sandboxDir, "data");

		const store = new ChatStore({ workingDir: dataDir });
		const chatId = "123456789";
		const ts1 = String(1700000000123);
		const iso1 = new Date(Number.parseInt(ts1, 10)).toISOString();

		const ok1 = await store.logMessage(chatId, {
			date: "",
			ts: ts1,
			user: "u1",
			userName: "alice",
			text: "hello",
			attachments: [
				{ original: "x.png", local: "local/x.png" }
			],
			isBot: false
		});
		expect(ok1).toBe(true);

		const ts2 = String(1700000000456);
		await store.logBotResponse(chatId, "reply", ts2);

		const logPath = join(dataDir, `chat-${chatId}`, "log.jsonl");
		const content = await readFile(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2);

		const msg1 = JSON.parse(lines[0]);
		expect(msg1.ts).toBe(ts1);
		expect(msg1.date).toBe(iso1);
		expect(msg1.attachments).toEqual([]);
		expect(msg1.isBot).toBe(false);

		const msg2 = JSON.parse(lines[1]);
		expect(msg2.ts).toBe(ts2);
		expect(msg2.attachments).toEqual([]);
		expect(msg2.isBot).toBe(true);

		expect(store.getLastTimestamp(chatId)).toBe(ts2);
	});
});
