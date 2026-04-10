import { describe, expect, it } from "vitest";

import {
  extractCommand,
  extractCommandForBot,
  extractMessageContent,
  formatDebugReply,
  formatHelpReply,
  formatStartReply,
  getMessageHandlingDecision,
  isExplicitTrigger,
  isUserContentMessage,
  normalizeTelegramHtml,
  renderStreamingPreview,
  splitText,
  shouldHandleMessage,
  type TelegramMessage
} from "../src/telegram.js";
import {
  telegramUpdateMessageAudio,
  telegramUpdateMessageCommandWithArgs,
  telegramUpdateMessageDocument,
  telegramUpdateMessageForwardReplyTopic,
  telegramUpdateMessagePhotoCaption,
  telegramUpdateMessageStartPayload,
  telegramUpdateMessageSticker,
  telegramUpdateMessageVideo,
  telegramUpdateMessageVoice
} from "./fixtures/telegram-updates.js";

const baseMessage: TelegramMessage = {
  message_id: 1,
  date: 0,
  chat: { id: 1001, type: "private" },
  from: { id: 42, is_bot: false, first_name: "Test" }
};

const mergeMessage = (patch: Partial<TelegramMessage>): TelegramMessage => {
  return {
    ...baseMessage,
    ...patch,
    chat: {
      ...baseMessage.chat,
      ...(patch.chat ?? {})
    },
    from: {
      ...baseMessage.from,
      ...(patch.from ?? {})
    }
  } as TelegramMessage;
};

describe("telegram message filters", () => {
  it("extracts command and args from text entities", () => {
    const message = mergeMessage({
      text: "/start hello",
      entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(extractCommand(message)).toEqual({
      commandName: "start",
      commandArgs: "hello"
    });
  });

  it("extracts command from caption entities", () => {
    const message = mergeMessage({
      caption: "/start via caption",
      caption_entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(extractCommand(message)).toEqual({
      commandName: "start",
      commandArgs: "via caption"
    });
  });

  it("matches commands addressed to this bot", () => {
    const message = mergeMessage({
      text: "/help@MyBot now",
      entities: [{ type: "bot_command", offset: 0, length: 11 }]
    });

    expect(extractCommandForBot(message, "mybot")).toEqual({
      commandName: "help",
      commandArgs: "now"
    });
  });

  it("ignores commands addressed to a different bot", () => {
    const message = mergeMessage({
      text: "/help@otherbot now",
      entities: [{ type: "bot_command", offset: 0, length: 14 }]
    });

    expect(extractCommandForBot(message, "mybot")).toEqual({
      commandName: undefined,
      commandArgs: undefined
    });
    expect(extractCommand(message)).toEqual({
      commandName: "help",
      commandArgs: "now"
    });
  });

  it("does not treat mid-message bot_command entity as host command", () => {
    const message = mergeMessage({
      text: "say hi before /stop now",
      entities: [{ type: "bot_command", offset: 14, length: 5 }]
    });

    expect(extractCommand(message)).toEqual({
      commandName: "stop",
      commandArgs: "now"
    });
    expect(extractCommandForBot(message, "mybot")).toEqual({
      commandName: undefined,
      commandArgs: undefined
    });
  });

  it("filters service messages by positive content fields", () => {
    const serviceOnlyMessage = mergeMessage({
      new_chat_members: [{ id: 777, is_bot: false, first_name: "N" }]
    });
    const gameMessage = mergeMessage({ game: { title: "demo" } });
    const textMessage = mergeMessage({ text: "hello" });

    expect(isUserContentMessage(serviceOnlyMessage)).toBe(false);
    expect(isUserContentMessage(gameMessage)).toBe(false);
    expect(isUserContentMessage(textMessage)).toBe(true);
  });

  it("accepts explicit trigger from command", () => {
    const message = mergeMessage({
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }]
    });

    expect(isExplicitTrigger(message, { botId: 100, botUsername: "mybot" })).toBe(true);
  });

  it("accepts explicit trigger from reply-to-bot id", () => {
    const message = mergeMessage({
      text: "thanks",
      reply_to_message: {
        message_id: 2,
        date: 0,
        chat: { id: 1001, type: "private" },
        from: { id: 100, is_bot: true, first_name: "Bot" }
      }
    });

    expect(isExplicitTrigger(message, { botId: 100, botUsername: "mybot" })).toBe(true);
    expect(isExplicitTrigger(message, { botId: 101, botUsername: "mybot" })).toBe(false);
  });

  it("accepts explicit trigger from case-insensitive mention", () => {
    const message = mergeMessage({
      text: "ping @MyBoT please",
      entities: [{ type: "mention", offset: 5, length: 6 }]
    });

    expect(isExplicitTrigger(message, { botId: 100, botUsername: "mybot" })).toBe(true);
  });

  it("skips non-/start when chat is unauthorized", () => {
    const message = mergeMessage({
      chat: { id: 9999, type: "private" },
      text: "hello"
    });

    expect(
      shouldHandleMessage(message, {
        allowedChats: { "1001": {} },
        explicitOnly: false,
        botId: 100,
        botUsername: "mybot"
      })
    ).toBe(false);

    expect(
      getMessageHandlingDecision(message, {
        allowedChats: { "1001": {} },
        explicitOnly: false,
        botId: 100,
        botUsername: "mybot"
      })
    ).toEqual({
      shouldHandle: false,
      reason: "unauthorized_chat"
    });
  });

  it("enforces explicit_only flow for authorized chats", () => {
    const plainMessage = mergeMessage({ text: "hello" });
    const mentionMessage = mergeMessage({
      text: "hello @mybot",
      entities: [{ type: "mention", offset: 6, length: 6 }]
    });

    expect(
      shouldHandleMessage(plainMessage, {
        allowedChats: { "1001": {} },
        explicitOnly: true,
        botId: 100,
        botUsername: "mybot"
      })
    ).toBe(false);

    expect(
      getMessageHandlingDecision(plainMessage, {
        allowedChats: { "1001": {} },
        explicitOnly: true,
        botId: 100,
        botUsername: "mybot"
      })
    ).toEqual({
      shouldHandle: false,
      reason: "explicit_gate"
    });

    expect(
      shouldHandleMessage(mentionMessage, {
        allowedChats: { "1001": {} },
        explicitOnly: true,
        botId: 100,
        botUsername: "mybot"
      })
    ).toBe(true);

    expect(
      getMessageHandlingDecision(mentionMessage, {
        allowedChats: { "1001": {} },
        explicitOnly: true,
        botId: 100,
        botUsername: "mybot"
      })
    ).toEqual({
      shouldHandle: true,
      reason: "explicit_trigger"
    });
  });

  it("explains allowed-chat handling when explicit_only is off", () => {
    const message = mergeMessage({ text: "hello" });

    expect(
      getMessageHandlingDecision(message, {
        allowedChats: { "1001": {} },
        explicitOnly: false,
        botId: 100,
        botUsername: "mybot"
      })
    ).toEqual({
      shouldHandle: true,
      reason: "allowed_chat"
    });
  });

  it("explains non-user-content skips", () => {
    const message = mergeMessage({ new_chat_members: [{ id: 7, is_bot: false, first_name: "N" }] });

    expect(
      getMessageHandlingDecision(message, {
        allowedChats: { "1001": {} },
        explicitOnly: false,
        botId: 100,
        botUsername: "mybot"
      })
    ).toEqual({
      shouldHandle: false,
      reason: "non_user_content"
    });
  });
});

describe("extract", () => {
  const asMessage = (fixture: Record<string, unknown>): TelegramMessage => {
    return fixture.message as TelegramMessage;
  };

  it("extracts base text metadata and command arguments", () => {
    const message = asMessage(telegramUpdateMessageCommandWithArgs);

    expect(extractMessageContent(message)).toEqual({
      chatId: 1,
      chatType: "private",
      fromId: 2,
      fromFirstName: "Alice",
      messageId: 2,
      contentType: "text",
      textPreview: "/ask weather in shanghai",
      commandName: "ask",
      commandArgs: "weather in shanghai",
      caption: undefined,
      repliedMessageId: undefined,
      messageThreadId: undefined,
      forwardOriginType: undefined,
      mediaGroupId: undefined
    });
  });

  it("extracts photo caption, forward/reply/topic and media group", () => {
    const photo = extractMessageContent(asMessage(telegramUpdateMessagePhotoCaption));
    const forwarded = extractMessageContent(asMessage(telegramUpdateMessageForwardReplyTopic));

    expect(photo.contentType).toBe("photo");
    expect(photo.caption).toBe("screenshot from prod");
    expect(photo.mediaGroupId).toBe("grp-1");

    expect(forwarded.contentType).toBe("forward");
    expect(forwarded.repliedMessageId).toBe(99);
    expect(forwarded.messageThreadId).toBe(777);
    expect(forwarded.forwardOriginType).toBe("channel");
  });

  it("truncates text preview at exactly 200 characters", () => {
    const longText = `${"a".repeat(210)} tail`;
    const summary = extractMessageContent(mergeMessage({ text: longText }));

    expect(summary.textPreview).toBe(`${"a".repeat(197)}...`);
    expect(summary.textPreview?.length).toBe(200);
  });

  it("extracts non-text media content types", () => {
    const fixtures = [
      [telegramUpdateMessageDocument, "document"],
      [telegramUpdateMessageVoice, "voice"],
      [telegramUpdateMessageVideo, "video"],
      [telegramUpdateMessageAudio, "audio"],
      [telegramUpdateMessageSticker, "sticker"]
    ] as const;

    for (const [fixture, contentType] of fixtures) {
      expect(extractMessageContent(asMessage(fixture)).contentType).toBe(contentType);
    }
  });

  it("extracts additional design-required content types", () => {
    const cases: Array<[Partial<TelegramMessage>, string]> = [
      [{ forward_origin: { type: "user" }, text: "fwd" }, "forward"],
      [{ animation: { file_id: "anim-1" } }, "animation"],
      [{ video_note: { file_id: "vn-1" } }, "video_note"],
      [{ location: { latitude: 1, longitude: 2 } }, "location"],
      [{ contact: { phone_number: "123", first_name: "Tom" } }, "contact"],
      [{ venue: { title: "Cafe" } }, "venue"],
      [{ poll: { id: "p1" } }, "poll"],
      [{ dice: { emoji: "🎲", value: 6 } }, "dice"]
    ];

    for (const [patch, expectedType] of cases) {
    expect(extractMessageContent(mergeMessage(patch)).contentType).toBe(expectedType);
    }
  });

  it("formats debug reply as telegram html", () => {
    const summary = extractMessageContent(asMessage(telegramUpdateMessageCommandWithArgs));

    expect(formatDebugReply(summary)).toBe(
      `<pre>${[
        "debug_message",
        "chat.id=1",
        "chat.type=private",
        "from.id=2",
        "from.first_name=Alice",
        "message_id=2",
        "content_type=text",
        "text_preview=/ask weather in shanghai",
        "command=ask",
        "command_args=weather in shanghai",
        "caption=(none)",
        "reply_to_message_id=(none)",
        "message_thread_id=(none)",
        "forward_origin_type=(none)",
        "media_group_id=(none)"
      ].join("\n")}</pre>`
    );
  });
});

describe("start", () => {
  const asMessage = (fixture: Record<string, unknown>): TelegramMessage => {
    return fixture.message as TelegramMessage;
  };

  it("formats /start reply without payload", () => {
    const message = mergeMessage({
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(formatStartReply(message, "pigeon-bot", true, { explicitOnly: true })).toBe(
      [
        "<b>🐦 基础信息</b>",
        "- 宿主：<code>Pigeon</code>",
        "- Bot：<code>pigeon-bot</code>",
        "- Chat ID：<code>1001</code>",
        "- Topic：当前消息不在 topic 中",
        "- 命令：<code>/help</code> 查看可用命令，<code>/stop</code> 停止当前任务",
        "",
        "<b>ℹ️ 当前状态</b>",
        "- 当前 chat 已完成配置并启用",
        "- Chat 类型：<code>private</code>",
        "- 响应模式：仅响应命令 / @提及 / 回复",
        "- 作用范围：当前会话按 chat 共享，topic 不单独隔离",
        "- 当前会话会复用已有上下文与记忆"
      ].join("\n")
    );
  });

  it("formats /start reply for unauthorized chats", () => {
    const message = mergeMessage({
  chat: { id: 5550199901, type: "private" },
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(formatStartReply(message, "pigeon-bot", false, { explicitOnly: true })).toBe(
      [
        "<b>🐦 基础信息</b>",
        "- 宿主：<code>Pigeon</code>",
        "- Bot：<code>pigeon-bot</code>",
  "- Chat ID：<code>5550199901</code>",
        "- Topic：当前消息不在 topic 中",
        "- 命令：<code>/help</code> 查看可用命令，<code>/stop</code> 停止当前任务",
        "",
        "<b>🔒 配置指引</b>",
        "- 当前 chat 尚未加入允许列表",
        "- 配置作用域按 chat 生效，topic 不单独配置",
        "- 请在 <code>settings.json</code> 的 <code>allowed_chats</code> 中添加下面这一行映射：",
  `<pre>"5550199901": {}</pre>`,
        "- 完成配置后重新发送 <code>/start</code> 即可看到启用状态"
      ].join("\n")
    );
  });

  it("formats /start reply with payload", () => {
    const message = asMessage(telegramUpdateMessageStartPayload);

    const reply = formatStartReply(message, "pigeon-bot", false, { explicitOnly: true });
    const payloadIndex = reply.indexOf("- Start Payload：<code>ticket-42</code>");
    const guidanceIndex = reply.indexOf("<b>🔒 配置指引</b>");

    expect(reply).toContain("- Start Payload：<code>ticket-42</code>");
    expect(reply).toContain("<b>🐦 基础信息</b>");
    expect(reply).toContain("<b>🔒 配置指引</b>");
    expect(reply.match(/<b>🐦 基础信息<\/b>/g)).toHaveLength(1);
    expect(reply.match(/<b>🔒 配置指引<\/b>/g)).toHaveLength(1);
    expect(payloadIndex).toBeGreaterThan(-1);
    expect(guidanceIndex).toBeGreaterThan(-1);
    expect(payloadIndex).toBeLessThan(guidanceIndex);
  });

  it("escapes user-controlled payload in /start html", () => {
    const message = mergeMessage({
      text: "/start <tag>&",
      entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    const reply = formatStartReply(message, "pigeon-bot", false, { explicitOnly: true });

    expect(reply).toContain("- Start Payload：<code>&lt;tag&gt;&amp;</code>");
  });

  it("formats /start with shared base section regardless of authorization", () => {
    const authorized = formatStartReply(mergeMessage({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }), "pigeon-bot", true, { explicitOnly: true });
  const unauthorized = formatStartReply(mergeMessage({ chat: { id: 5550199901, type: "private" }, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }), "pigeon-bot", false, { explicitOnly: true });

    for (const reply of [authorized, unauthorized]) {
      expect(reply).toContain("<b>🐦 基础信息</b>");
      expect(reply).toContain("- 宿主：<code>Pigeon</code>");
      expect(reply).toContain("- Bot：<code>pigeon-bot</code>");
      expect(reply).toContain("- Topic：当前消息不在 topic 中");
      expect(reply).toContain("- 命令：<code>/help</code> 查看可用命令，<code>/stop</code> 停止当前任务");
    }
  });

  it("reports topic id while clarifying scope stays chat-level", () => {
    const reply = formatStartReply(
      asMessage(telegramUpdateMessageForwardReplyTopic),
      "pigeon-bot",
      true,
      { explicitOnly: true }
    );

    expect(reply).toContain("- Topic：<code>777</code>");
    expect(reply).toContain("- 作用范围：当前会话按 chat 共享，topic 不单独隔离");
  });

  it("keeps /start payload reply to exactly two sections for authorized chats", () => {
    const reply = formatStartReply(
      mergeMessage({ text: "/start ticket-42", entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
      "pigeon-bot",
      true,
      { explicitOnly: false }
    );
    const payloadIndex = reply.indexOf("- Start Payload：<code>ticket-42</code>");
    const statusIndex = reply.indexOf("<b>ℹ️ 当前状态</b>");

    expect(reply).toContain("<b>🐦 基础信息</b>");
    expect(reply).toContain("<b>ℹ️ 当前状态</b>");
    expect(reply).toContain("- Start Payload：<code>ticket-42</code>");
    expect(reply).toContain("- 响应模式：响应该 chat 中的所有消息");
    expect(reply.match(/<b>🐦 基础信息<\/b>/g)).toHaveLength(1);
    expect(reply.match(/<b>ℹ️ 当前状态<\/b>/g)).toHaveLength(1);
    expect(payloadIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeGreaterThan(-1);
    expect(payloadIndex).toBeLessThan(statusIndex);
  });

  it("formats /help reply", () => {
    expect(formatHelpReply("pigeon-bot")).toBe(
      [
        `<b>🐦 Pigeon</b>\n`,
        "<code>/start</code> — 查看当前状态与配置指引",
        "<code>/help</code> — 查看可用命令",
        "<code>/stop</code> — 停止当前任务",
        `\n在已启用的 chat 中，可通过命令、@提及或回复机器人发起对话；若该 chat 关闭显式触发，也可直接发送消息。`
      ].join("\n")
    );
  });

  it("normalizes malformed telegram html while preserving supported tags", () => {
    expect(normalizeTelegramHtml("<b>hello<script>x</script>")).toBe("<b>hello&lt;script&gt;x&lt;/script&gt;</b>");
  });

  it("renders streaming preview as escaped telegram html", () => {
    expect(renderStreamingPreview("<b>tag</b>" as string)).toBe("&lt;b&gt;tag&lt;/b&gt;▌");
  });

  it("splits long telegram html without breaking tags", () => {
    const long = normalizeTelegramHtml(`<b>${"a".repeat(5000)}</b>`);
    const parts = splitText(long);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.endsWith("</b>")).toBe(true);
    expect(parts[1]!.startsWith("<b>")).toBe(true);
  });
});
