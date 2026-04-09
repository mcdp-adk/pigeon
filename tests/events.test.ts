import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventsWatcher } from "../src/events.js";

describe("EventsWatcher", () => {
	let sandboxDir = "";

	afterEach(async () => {
		if (sandboxDir) {
			await rm(sandboxDir, { recursive: true, force: true });
		}
	});

	it("immediate 事件触发并删除文件", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "test-immediate.json");
		await writeFile(filePath, JSON.stringify({ type: "immediate", chatId: "123", text: "hello" }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]!.text).toContain("[EVENT:");
		expect(triggered[0]!.text).toContain("hello");
		expect(existsSync(filePath)).toBe(false);
	});

	it("immediate 事件格式为 [EVENT:filename:type:schedule] text", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		await writeFile(
			join(eventsDir, "remind.json"),
			JSON.stringify({ type: "immediate", chatId: "456", text: "check inbox" })
		);

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered[0]!.text).toBe("[EVENT:remind.json:immediate:immediate] check inbox");
	});

	it("one-shot 过期事件删除不触发", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		const pastTime = new Date(Date.now() - 60000).toISOString();
		const filePath = join(eventsDir, "past.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "past event", at: pastTime }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(false);
	});

	it("invalid 事件文件被删除", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "bad.json");
		await writeFile(filePath, JSON.stringify({ type: "immediate", text: "missing chatId" }));

		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(false);
	});

	it("one-shot 未来事件在指定时间触发", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const futureTime = new Date(Date.now() + 300).toISOString();
		const filePath = join(eventsDir, "future.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "future event", at: futureTime }));

		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(triggered).toHaveLength(0);

		await new Promise((resolve) => setTimeout(resolve, 400));
		watcher.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]!.text).toContain("future event");
		expect(existsSync(filePath)).toBe(false);
	});

	it("one-shot NaN 时间戳被删除", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "nan.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "bad time", at: "not-a-date" }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(false);
	});

	it("periodic 事件按 cron 触发，文件不删除", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "periodic.json");
		await writeFile(filePath, JSON.stringify({
			type: "periodic",
			chatId: "123",
			text: "tick",
			schedule: "* * * * * *",
			timezone: "UTC"
		}));

		await new Promise((resolve) => setTimeout(resolve, 2500));
		watcher.stop();

		expect(triggered.length).toBeGreaterThanOrEqual(2);
		expect(existsSync(filePath)).toBe(true);
	});

	it("删除事件文件取消调度", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const futureTime = new Date(Date.now() + 500).toISOString();
		const filePath = join(eventsDir, "cancel.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "should not fire", at: futureTime }));

		await new Promise((resolve) => setTimeout(resolve, 100));
		await rm(filePath);

		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.stop();

		expect(triggered).toHaveLength(0);
	});

	it("stale immediate 事件（启动前写入）被删除不触发", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		// 先写文件，再启动 watcher，模拟 stale
		const { mkdirSync } = await import("node:fs");
		mkdirSync(eventsDir, { recursive: true });
		const filePath = join(eventsDir, "stale.json");
		await writeFile(filePath, JSON.stringify({ type: "immediate", chatId: "123", text: "stale" }));

		// 等一小段时间确保 mtime < startTime
		await new Promise((resolve) => setTimeout(resolve, 50));

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => triggered.push(e));
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(false);
	});
});
