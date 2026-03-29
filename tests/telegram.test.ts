import { describe, expect, it } from "vitest";

import {
  extractMessageContent,
  formatDebugReply,
  formatStartReply,
  isExplicitTrigger,
  isStartCommand,
  isUserContentMessage,
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
  it("recognizes /start from text entities", () => {
    const message = mergeMessage({
      text: "/start hello",
      entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(isStartCommand(message)).toBe(true);
  });

  it("recognizes /start from caption_entities", () => {
    const message = mergeMessage({
      caption: "/start via caption",
      caption_entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(isStartCommand(message)).toBe(true);
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

  it("allows /start even when chat is unauthorized", () => {
    const message = mergeMessage({
      chat: { id: 9999, type: "private" },
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }]
    });

    expect(
      shouldHandleMessage(message, {
        allowedChats: { "1001": {} },
        explicitOnly: true,
        botId: 100,
        botUsername: "mybot"
      })
    ).toBe(true);
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
      shouldHandleMessage(mentionMessage, {
        allowedChats: { "1001": {} },
        explicitOnly: true,
        botId: 100,
        botUsername: "mybot"
      })
    ).toBe(true);
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

  it("formats plain-text debug reply", () => {
    const summary = extractMessageContent(asMessage(telegramUpdateMessageCommandWithArgs));

    expect(formatDebugReply(summary)).toBe(
      [
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
      ].join("\n")
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

    expect(formatStartReply(message, "pigeon-bot")).toBe(
      [
        "Hello from pigeon-bot.",
        "chat.id=1001",
        "chat.type=private",
        "Put this chat id into settings.json:",
        '"allowed_chats": { "1001": {} }',
        "start_payload=(none)"
      ].join("\n")
    );
  });

  it("formats /start reply with payload", () => {
    const message = asMessage(telegramUpdateMessageStartPayload);

    expect(formatStartReply(message, "pigeon-bot")).toContain("start_payload=ticket-42");
    expect(formatStartReply(message, "pigeon-bot")).toContain("chat.id=555");
    expect(formatStartReply(message, "pigeon-bot")).toContain("chat.type=group");
  });
});
