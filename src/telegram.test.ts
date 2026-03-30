import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createResponseContext } from "./telegram.js";

describe("TelegramResponseContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should send initial message and track message id", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: vi.fn() }
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();

    expect(replyMock).toHaveBeenCalledWith("_⏳ 正在处理..._", { parse_mode: "Markdown" });
  });

  it("should throttle updateProgress edits to at most once per 2 seconds", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMessageTextMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMessageTextMock }
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();

    // First update should be executed immediately
    await responseCtx.updateProgress("step 1");
    expect(editMessageTextMock).toHaveBeenCalledWith(
      456,
      123,
      "_⏳ 正在处理..._\n→ step 1",
      { parse_mode: "Markdown" }
    );
    editMessageTextMock.mockClear();

    // Multiple updates within 2 seconds should be coalesced
    await responseCtx.updateProgress("step 2");
    await responseCtx.updateProgress("step 3");
    expect(editMessageTextMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(editMessageTextMock).toHaveBeenCalledWith(
      456,
      123,
      "_⏳ 正在处理..._\n→ step 1\n→ step 2\n→ step 3",
      { parse_mode: "Markdown" }
    );
  });

  it("should use sendMessageDraft for sendFinal if available", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const sendMessageDraftMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      update: { update_id: 789 },
      api: { 
        editMessageText: vi.fn(),
        sendMessageDraft: sendMessageDraftMock
      }
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    await responseCtx.sendFinal("final text");

    expect(sendMessageDraftMock).toHaveBeenCalledWith(456, 789, "final text");
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
  });

  it("should fallback to editMessageText for sendFinal if sendMessageDraft is unavailable", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMessageTextMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      update: { update_id: 789 },
      api: { 
        editMessageText: editMessageTextMock
        // sendMessageDraft is undefined
      }
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    await responseCtx.sendFinal("final text");

    expect(editMessageTextMock).toHaveBeenCalledWith(456, 123, "final text", { parse_mode: "Markdown" });
  });

  it("should fallback to reply for sendFinal if editMessageText fails", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMessageTextMock = vi.fn().mockRejectedValue(new Error("Message not modified"));
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      update: { update_id: 789 },
      api: { 
        editMessageText: editMessageTextMock
      }
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    replyMock.mockClear();
    await responseCtx.sendFinal("final text");

    expect(editMessageTextMock).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith("final text", { parse_mode: "Markdown" });
  });

  it("should update message to stopped when markStopped is called", async () => {
    const replyMock = vi.fn().mockResolvedValue({ message_id: 123 });
    const editMessageTextMock = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply: replyMock,
      chat: { id: 456 },
      api: { editMessageText: editMessageTextMock }
    } as any;

    const responseCtx = createResponseContext(ctx);
    await responseCtx.sendInitial();
    await responseCtx.markStopped();

    expect(editMessageTextMock).toHaveBeenCalledWith(
      456,
      123,
      "_已停止。_",
      { parse_mode: "Markdown" }
    );
  });
});
