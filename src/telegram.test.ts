import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResponseContext } from "./telegram.js";

describe("TelegramResponseContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("发送初始消息并跟踪消息 ID", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: vi.fn() },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();

    expect(replyMock).toHaveBeenCalledWith("<i>⏳ 正在处理...</i>", { parse_mode: "HTML" });
  });

  it("updateProgress 在 1 秒内合并多次更新", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMock },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();

    await responseCtx.updateProgress("步骤 1");
    expect(editMock).toHaveBeenCalledWith(456, 123, "<i>⏳ 正在处理...</i>\n→ 步骤 1", { parse_mode: "HTML" });
    editMock.mockClear();

    await responseCtx.updateProgress("步骤 2");
    await responseCtx.updateProgress("步骤 3");
    expect(editMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(editMock).toHaveBeenCalledWith(
      456,
      123,
      "<i>⏳ 正在处理...</i>\n→ 步骤 1\n→ 步骤 2\n→ 步骤 3",
      { parse_mode: "HTML" },
    );
  });

  it("sendFinal 编辑已有消息，使用 HTML 格式", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMock },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    await responseCtx.sendFinal("最终回复");

    expect(editMock).toHaveBeenCalledWith(456, 123, "最终回复", { parse_mode: "HTML" });
  });

  it("sendFinal 在没有占位消息时直接发送新消息", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: vi.fn() },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendFinal("最终回复");

    expect(replyMock).toHaveBeenCalledWith("最终回复", { parse_mode: "HTML" });
  });

  it("appendDelta 首次调用清空进度文字，后续追加 delta", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMock },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    await responseCtx.updateProgress("工具调用");
    editMock.mockClear();

    await responseCtx.appendDelta("你");
    expect(editMock).toHaveBeenCalledWith(456, 123, "<i>...</i>", { parse_mode: "HTML" });
    editMock.mockClear();

    await responseCtx.appendDelta("好");
    expect(editMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(editMock).toHaveBeenCalledWith(456, 123, "你好", { parse_mode: "HTML" });
  });

  it("appendDelta 在 1 秒内节流合并", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMock },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();

    await responseCtx.appendDelta("你");
    editMock.mockClear();

    await responseCtx.appendDelta("好");
    await responseCtx.appendDelta("世界");
    expect(editMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(editMock).toHaveBeenCalledWith(456, 123, "你好世界", { parse_mode: "HTML" });
  });

  it("markStopped 将消息替换为停止提示", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMock },
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    await responseCtx.markStopped();

    expect(editMock).toHaveBeenCalledWith(456, 123, "<i>已停止。</i>", { parse_mode: "HTML" });
  });
});
