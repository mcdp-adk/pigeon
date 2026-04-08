import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { logInfo, logWarning } from "./log.js";

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
  type: "immediate";
  chatId: string;
  text: string;
}

export interface OneShotEvent {
  type: "one-shot";
  chatId: string;
  text: string;
  at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
  type: "periodic";
  chatId: string;
  text: string;
  schedule: string; // cron syntax
  timezone: string; // IANA timezone
}

export type PigeonEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export interface EventTrigger {
  chatId: string;
  text: string; // formatted: [EVENT:filename:type:schedule] text
}

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventsWatcher {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private crons: Map<string, Cron> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private startTime: number;
  private watcher: FSWatcher | null = null;
  private knownFiles: Set<string> = new Set();

  constructor(
    private readonly eventsDir: string,
    private readonly onTrigger: (event: EventTrigger) => void
  ) {
    this.startTime = Date.now();
  }

  start(): void {
    if (!existsSync(this.eventsDir)) {
      mkdirSync(this.eventsDir, { recursive: true });
    }

    logInfo("Events watcher starting", { dir: this.eventsDir });

    this.scanExisting();

    this.watcher = watch(this.eventsDir, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      this.debounce(filename, () => this.handleFileChange(filename));
    });

    logInfo("Events watcher started", { tracked: this.knownFiles.size });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();

    this.knownFiles.clear();
    logInfo("Events watcher stopped");
  }

  private debounce(filename: string, fn: () => void): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      filename,
      setTimeout(() => {
        this.debounceTimers.delete(filename);
        fn();
      }, DEBOUNCE_MS)
    );
  }

  private scanExisting(): void {
    let files: string[];
    try {
      files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
    } catch (err) {
      logWarning("Failed to read events directory", { error: String(err) });
      return;
    }
    for (const filename of files) {
      void this.handleFile(filename);
    }
  }

  private handleFileChange(filename: string): void {
    const filePath = join(this.eventsDir, filename);
    if (!existsSync(filePath)) {
      this.handleDelete(filename);
    } else if (this.knownFiles.has(filename)) {
      this.cancelScheduled(filename);
      void this.handleFile(filename);
    } else {
      void this.handleFile(filename);
    }
  }

  private handleDelete(filename: string): void {
    if (!this.knownFiles.has(filename)) return;
    logInfo("Event file deleted", { filename });
    this.cancelScheduled(filename);
    this.knownFiles.delete(filename);
  }

  private cancelScheduled(filename: string): void {
    const timer = this.timers.get(filename);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(filename);
    }
    const cron = this.crons.get(filename);
    if (cron) {
      cron.stop();
      this.crons.delete(filename);
    }
  }

  private async handleFile(filename: string): Promise<void> {
    const filePath = join(this.eventsDir, filename);

    let event: PigeonEvent | null = null;
    let lastError: Error | null = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const content = await readFile(filePath, "utf-8");
        event = this.parseEvent(content, filename);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < MAX_RETRIES - 1) {
          await this.sleep(RETRY_BASE_MS * 2 ** i);
        }
      }
    }

    if (!event) {
      logWarning("Failed to parse event file, deleting", { filename, error: lastError?.message });
      this.deleteFile(filename);
      return;
    }

    this.knownFiles.add(filename);

    switch (event.type) {
      case "immediate":
        this.handleImmediate(filename, event);
        break;
      case "one-shot":
        this.handleOneShot(filename, event);
        break;
      case "periodic":
        this.handlePeriodic(filename, event);
        break;
    }
  }

  private parseEvent(content: string, filename: string): PigeonEvent {
    const data = JSON.parse(content) as Record<string, unknown>;

    if (!data["type"] || !data["chatId"] || !data["text"]) {
      throw new Error(`Missing required fields (type, chatId, text) in ${filename}`);
    }

    const chatId = String(data["chatId"]);
    const text = String(data["text"]);

    switch (data["type"]) {
      case "immediate":
        return { type: "immediate", chatId, text };

      case "one-shot":
        if (!data["at"]) throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
        return { type: "one-shot", chatId, text, at: String(data["at"]) };

      case "periodic":
        if (!data["schedule"]) throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
        if (!data["timezone"]) throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
        return {
          type: "periodic",
          chatId,
          text,
          schedule: String(data["schedule"]),
          timezone: String(data["timezone"]),
        };

      default:
        throw new Error(`Unknown event type '${String(data["type"])}' in ${filename}`);
    }
  }

  private handleImmediate(filename: string, event: ImmediateEvent): void {
    const filePath = join(this.eventsDir, filename);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < this.startTime) {
        logInfo("Stale immediate event, deleting", { filename });
        this.deleteFile(filename);
        return;
      }
    } catch {
      return;
    }
    logInfo("Executing immediate event", { filename });
    this.execute(filename, event);
  }

  private handleOneShot(filename: string, event: OneShotEvent): void {
    const atTime = new Date(event.at).getTime();
    const now = Date.now();
    if (atTime <= now) {
      logInfo("One-shot event in the past, deleting", { filename });
      this.deleteFile(filename);
      return;
    }
    const delay = atTime - now;
    logInfo("Scheduling one-shot event", { filename, delay_s: Math.round(delay / 1000) });
    const timer = setTimeout(() => {
      this.timers.delete(filename);
      logInfo("Executing one-shot event", { filename });
      this.execute(filename, event);
    }, delay);
    this.timers.set(filename, timer);
  }

  private handlePeriodic(filename: string, event: PeriodicEvent): void {
    try {
      const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
        logInfo("Executing periodic event", { filename });
        this.execute(filename, event, false);
      });
      this.crons.set(filename, cron);
      const next = cron.nextRun();
      logInfo("Scheduled periodic event", { filename, next: next?.toISOString() ?? "unknown" });
    } catch (err) {
      logWarning("Invalid cron schedule, deleting", { filename, schedule: event.schedule, error: String(err) });
      this.deleteFile(filename);
    }
  }

  private execute(filename: string, event: PigeonEvent, deleteAfter = true): void {
    let scheduleInfo: string;
    switch (event.type) {
      case "immediate":
        scheduleInfo = "immediate";
        break;
      case "one-shot":
        scheduleInfo = event.at;
        break;
      case "periodic":
        scheduleInfo = event.schedule;
        break;
    }

    const text = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;
    this.onTrigger({ chatId: event.chatId, text });

    if (deleteAfter) {
      this.deleteFile(filename);
    }
  }

  private deleteFile(filename: string): void {
    const filePath = join(this.eventsDir, filename);
    try {
      unlinkSync(filePath);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
        logWarning("Failed to delete event file", { filename, error: String(err) });
      }
    }
    this.knownFiles.delete(filename);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createEventsWatcher(
  dataDir: string,
  onTrigger: (event: EventTrigger) => void
): EventsWatcher {
  return new EventsWatcher(join(dataDir, "events"), onTrigger);
}
