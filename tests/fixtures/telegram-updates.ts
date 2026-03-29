export type TelegramUpdateFixture = Record<string, unknown>;

export const telegramUpdateMessageText = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
    from: {
      id: 1,
      is_bot: false,
      first_name: "Test",
      username: "test",
    },
    text: "/start",
  },
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageCommandWithArgs = {
  update_id: 2,
  message: {
    message_id: 2,
    date: 0,
    chat: { id: 1, type: "private" },
    from: {
      id: 2,
      is_bot: false,
      first_name: "Alice"
    },
    text: "/ask weather in shanghai",
    entities: [{ type: "bot_command", offset: 0, length: 4 }]
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessagePhotoCaption = {
  update_id: 3,
  message: {
    message_id: 3,
    date: 0,
    chat: { id: -100987, type: "supergroup" },
    from: {
      id: 3,
      is_bot: false,
      first_name: "Bob"
    },
    photo: [{ file_id: "p1" }],
    caption: "screenshot from prod",
    media_group_id: "grp-1"
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageForwardReplyTopic = {
  update_id: 4,
  message: {
    message_id: 4,
    date: 0,
    chat: { id: -100987, type: "supergroup" },
    from: {
      id: 4,
      is_bot: false,
      first_name: "Carol"
    },
    text: "please check",
    message_thread_id: 777,
    reply_to_message: {
      message_id: 99,
      date: 0,
      chat: { id: -100987, type: "supergroup" },
      from: { id: 11, is_bot: true, first_name: "Notifier" }
    },
    forward_origin: {
      type: "channel",
      date: 0,
      chat: { id: -200, type: "channel", title: "News" }
    }
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageStartPayload = {
  update_id: 5,
  message: {
    message_id: 5,
    date: 0,
    chat: { id: 555, type: "group" },
    from: {
      id: 5,
      is_bot: false,
      first_name: "Dave"
    },
    text: "/start ticket-42",
    entities: [{ type: "bot_command", offset: 0, length: 6 }]
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageDocument = {
  update_id: 6,
  message: {
    message_id: 6,
    date: 0,
    chat: { id: 700, type: "private" },
    from: {
      id: 6,
      is_bot: false,
      first_name: "Eve"
    },
    document: { file_id: "d1" }
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageVoice = {
  update_id: 7,
  message: {
    message_id: 7,
    date: 0,
    chat: { id: 701, type: "private" },
    from: {
      id: 7,
      is_bot: false,
      first_name: "Frank"
    },
    voice: { file_id: "v1" }
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageVideo = {
  update_id: 8,
  message: {
    message_id: 8,
    date: 0,
    chat: { id: 702, type: "private" },
    from: {
      id: 8,
      is_bot: false,
      first_name: "Grace"
    },
    video: { file_id: "vid1" }
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageAudio = {
  update_id: 9,
  message: {
    message_id: 9,
    date: 0,
    chat: { id: 703, type: "private" },
    from: {
      id: 9,
      is_bot: false,
      first_name: "Heidi"
    },
    audio: { file_id: "a1" }
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdateMessageSticker = {
  update_id: 10,
  message: {
    message_id: 10,
    date: 0,
    chat: { id: 704, type: "private" },
    from: {
      id: 10,
      is_bot: false,
      first_name: "Ivan"
    },
    sticker: { file_id: "s1" }
  }
} as const satisfies TelegramUpdateFixture;

export const telegramUpdates = [
  telegramUpdateMessageText,
  telegramUpdateMessageCommandWithArgs,
  telegramUpdateMessagePhotoCaption,
  telegramUpdateMessageForwardReplyTopic,
  telegramUpdateMessageStartPayload,
  telegramUpdateMessageDocument,
  telegramUpdateMessageVoice,
  telegramUpdateMessageVideo,
  telegramUpdateMessageAudio,
  telegramUpdateMessageSticker
] as const satisfies readonly TelegramUpdateFixture[];
