import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filename = "test-immediate.json";
		const filePath = join(eventsDir, filename);
		await writeFile(filePath, JSON.stringify({ type: "immediate", chatId: "123", text: "hello" }));

		await new Promise((resolve) => setTimeout(resolve, 300));

		watcher.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]).toMatchObject({ chatId: "123", text: expect.stringContaining("[EVENT:") });
		expect(triggered[0]!.text).toContain("hello");
		expect(existsSync(filePath)).toBe(false);
	});

	it("immediate 事件格式为 [EVENT:filename:type:schedule] text", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
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

	it("one-shot 过期事件立即执行并删除", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher.start();

		const pastTime = new Date(Date.now() - 60000).toISOString();
		const filePath = join(eventsDir, "past.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "past event", at: pastTime }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]!.text).toContain("past event");
		expect(existsSync(filePath)).toBe(false);
	});

	it("invalid 事件文件被删除", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "bad.json");
		await writeFile(filePath, JSON.stringify({ type: "unknown", chatId: "123", text: "msg" }));

		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(false);
	});

	it("periodic 事件不触发不删除（cron 未到时间）", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher.start();

		const filePath = join(eventsDir, "periodic.json");
		await writeFile(
			filePath,
			JSON.stringify({ type: "periodic", chatId: "123", text: "daily check", schedule: "0 23 31 2 *", timezone: "UTC" })
		);

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(true);
	});

	it("one-shot 未来事件到点触发并删除文件", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const futureTime = new Date(Date.now() + 500).toISOString();
		const filePath = join(eventsDir, "future.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "789", text: "wake up", at: futureTime }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(triggered).toHaveLength(0);

		await new Promise((resolve) => setTimeout(resolve, 500));
		watcher.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]!.text).toContain("[EVENT:future.json:one-shot:");
		expect(triggered[0]!.text).toContain("wake up");
		expect(existsSync(filePath)).toBe(false);
	});

	it("one-shot 非法 'at' 时间戳被拒绝并删除", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const triggered: { chatId: string; text: string }[] = [];
		const watcher = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "bad-time.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "bad", at: "not-a-date" }));

		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.stop();

		expect(triggered).toHaveLength(0);
		expect(existsSync(filePath)).toBe(false);
	});

	it("immediate 事件被拒绝时保留文件", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const watcher = new EventsWatcher(eventsDir, () => false);
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "busy.json");
		await writeFile(filePath, JSON.stringify({ type: "immediate", chatId: "123", text: "busy test" }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher.stop();

		expect(existsSync(filePath)).toBe(true);
	});

	it("one-shot 事件被拒绝时保留文件", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const watcher = new EventsWatcher(eventsDir, () => false);
		watcher.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const futureTime = new Date(Date.now() + 300).toISOString();
		const filePath = join(eventsDir, "busy-oneshot.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "busy oneshot", at: futureTime }));

		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.stop();

		expect(existsSync(filePath)).toBe(true);
	});

	it("immediate 事件 busy 后重启 watcher 仍能恢复送达", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const watcher1 = new EventsWatcher(eventsDir, () => false);
		watcher1.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const filePath = join(eventsDir, "recover.json");
		await writeFile(filePath, JSON.stringify({ type: "immediate", chatId: "123", text: "recover me" }));

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher1.stop();

		expect(existsSync(filePath)).toBe(true);

		const triggered: { chatId: string; text: string }[] = [];
		const watcher2 = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher2.start();

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher2.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]!.text).toContain("recover me");
		expect(existsSync(filePath)).toBe(false);
	});

	it("one-shot 事件 busy 后重启 watcher 仍能恢复送达", async () => {
		sandboxDir = await mkdtemp(join(tmpdir(), "events-test-"));
		const eventsDir = join(sandboxDir, "events");

		const watcher1 = new EventsWatcher(eventsDir, () => false);
		watcher1.start();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const futureTime = new Date(Date.now() + 200).toISOString();
		const filePath = join(eventsDir, "recover-oneshot.json");
		await writeFile(filePath, JSON.stringify({ type: "one-shot", chatId: "123", text: "recover oneshot", at: futureTime }));

		await new Promise((resolve) => setTimeout(resolve, 500));
		watcher1.stop();

		expect(existsSync(filePath)).toBe(true);

		const triggered: { chatId: string; text: string }[] = [];
		const watcher2 = new EventsWatcher(eventsDir, (e) => { triggered.push(e); return true; });
		watcher2.start();

		await new Promise((resolve) => setTimeout(resolve, 300));
		watcher2.stop();

		expect(triggered).toHaveLength(1);
		expect(triggered[0]!.text).toContain("recover oneshot");
		expect(existsSync(filePath)).toBe(false);
	});
});
