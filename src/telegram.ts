type TelegramEntityType = "bot_command" | "mention" | string;

export interface TelegramEntity {
  type: TelegramEntityType;
  offset: number;
  length: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  photo?: unknown[];
  video?: unknown;
  animation?: unknown;
  audio?: unknown;
  document?: unknown;
  voice?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  dice?: unknown;
  game?: unknown;
  reply_to_message?: {
    message_id?: number;
    from?: TelegramUser;
    [key: string]: unknown;
  };
  message_thread_id?: number;
  forward_origin?: {
    type?: string;
    [key: string]: unknown;
  };
  media_group_id?: string;
  [key: string]: unknown;
}

export type ExtractedContentType =
  | "forward"
  | "text"
  | "photo"
  | "animation"
  | "document"
  | "voice"
  | "video"
  | "video_note"
  | "audio"
  | "sticker"
  | "location"
  | "contact"
  | "venue"
  | "poll"
  | "dice"
  | "other";

export interface ExtractedMessageContent {
  chatId: number;
  chatType: string;
  fromId: number | undefined;
  fromFirstName: string | undefined;
  messageId: number;
  contentType: ExtractedContentType;
  textPreview: string | undefined;
  commandName: string | undefined;
  commandArgs: string | undefined;
  caption: string | undefined;
  repliedMessageId: number | undefined;
  messageThreadId: number | undefined;
  forwardOriginType: string | undefined;
  mediaGroupId: string | undefined;
}

export interface TriggerBotIdentity {
  botId: number;
  botUsername?: string;
}

export interface ShouldHandleMessageOptions extends TriggerBotIdentity {
  explicitOnly: boolean;
  allowedChats: Readonly<Record<string, unknown>> | ReadonlySet<string>;
}

const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]+)?$/i;

const hasEntityCommand = (text: string | undefined, entities: TelegramEntity[] | undefined): boolean => {
  if (!text || !entities || entities.length === 0) {
    return false;
  }

  return entities.some((entity) => {
    if (entity.type !== "bot_command") {
      return false;
    }
    const commandText = text.slice(entity.offset, entity.offset + entity.length);
    return START_COMMAND.test(commandText);
  });
};

const hasAnyCommandEntity = (entities: TelegramEntity[] | undefined): boolean => {
  if (!entities || entities.length === 0) {
    return false;
  }

  return entities.some((entity) => entity.type === "bot_command");
};

const hasMentionForBot = (
  text: string | undefined,
  entities: TelegramEntity[] | undefined,
  botUsername: string | undefined
): boolean => {
  if (!text || !entities || entities.length === 0 || !botUsername) {
    return false;
  }

  const expectedMention = `@${botUsername}`.toLowerCase();
  return entities.some((entity) => {
    if (entity.type !== "mention") {
      return false;
    }
    const mentionText = text.slice(entity.offset, entity.offset + entity.length);
    return mentionText.toLowerCase() === expectedMention;
  });
};

const isChatAllowed = (
  chatId: number,
  allowedChats: Readonly<Record<string, unknown>> | ReadonlySet<string>
): boolean => {
  const key = String(chatId);
  if (allowedChats instanceof Set) {
    return allowedChats.has(key);
  }
  return key in allowedChats;
};

export const isStartCommand = (message: TelegramMessage): boolean => {
  return (
    hasEntityCommand(message.text, message.entities) ||
    hasEntityCommand(message.caption, message.caption_entities)
  );
};

export const isUserContentMessage = (message: TelegramMessage): boolean => {
  return Boolean(
    message.text ||
      message.caption ||
      message.photo ||
      message.video ||
      message.animation ||
      message.audio ||
      message.document ||
      message.voice ||
      message.video_note ||
      message.sticker ||
      message.contact ||
      message.location ||
      message.venue ||
      message.poll ||
      message.dice
  );
};

export const isExplicitTrigger = (
  message: TelegramMessage,
  bot: TriggerBotIdentity
): boolean => {
  if (
    hasAnyCommandEntity(message.entities) ||
    hasAnyCommandEntity(message.caption_entities)
  ) {
    return true;
  }

  if (message.reply_to_message?.from?.id === bot.botId) {
    return true;
  }

  return (
    hasMentionForBot(message.text, message.entities, bot.botUsername) ||
    hasMentionForBot(message.caption, message.caption_entities, bot.botUsername)
  );
};

export const shouldHandleMessage = (
  message: TelegramMessage,
  options: ShouldHandleMessageOptions
): boolean => {
  if (isStartCommand(message)) {
    return true;
  }

  if (!isChatAllowed(message.chat.id, options.allowedChats)) {
    return false;
  }

  if (!isUserContentMessage(message)) {
    return false;
  }

  if (!options.explicitOnly) {
    return true;
  }

  return isExplicitTrigger(message, {
    botId: options.botId,
    botUsername: options.botUsername
  });
};

const NONE = "(none)";
const PREVIEW_LIMIT = 200;

const toPreview = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  if (value.length <= PREVIEW_LIMIT) {
    return value;
  }
  return `${value.slice(0, PREVIEW_LIMIT - 3)}...`;
};

const getContentType = (message: TelegramMessage): ExtractedContentType => {
  if (message.forward_origin) {
    return "forward";
  }
  if (message.photo) {
    return "photo";
  }
  if (message.animation) {
    return "animation";
  }
  if (message.document) {
    return "document";
  }
  if (message.voice) {
    return "voice";
  }
  if (message.video) {
    return "video";
  }
  if (message.video_note) {
    return "video_note";
  }
  if (message.audio) {
    return "audio";
  }
  if (message.sticker) {
    return "sticker";
  }
  if (message.location) {
    return "location";
  }
  if (message.contact) {
    return "contact";
  }
  if (message.venue) {
    return "venue";
  }
  if (message.poll) {
    return "poll";
  }
  if (message.dice) {
    return "dice";
  }
  if (message.text || message.caption) {
    return "text";
  }
  return "other";
};

const extractCommand = (
  sourceText: string | undefined,
  entities: TelegramEntity[] | undefined
): { commandName: string | undefined; commandArgs: string | undefined } => {
  if (!sourceText || !entities || entities.length === 0) {
    return { commandName: undefined, commandArgs: undefined };
  }

  const commandEntity = entities.find((entity) => entity.type === "bot_command");
  if (!commandEntity) {
    return { commandName: undefined, commandArgs: undefined };
  }

  const rawCommand = sourceText
    .slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
    .trim();
  if (!rawCommand.startsWith("/")) {
    return { commandName: undefined, commandArgs: undefined };
  }

  const normalizedCommand = rawCommand.slice(1).split("@")[0]?.toLowerCase();
  const argsRaw = sourceText.slice(commandEntity.offset + commandEntity.length).trim();
  return {
    commandName: normalizedCommand || undefined,
    commandArgs: argsRaw || undefined
  };
};

const valueOrNone = (value: string | number | undefined): string => {
  if (value === undefined || value === "") {
    return NONE;
  }
  return String(value);
};

export const extractMessageContent = (message: TelegramMessage): ExtractedMessageContent => {
  const fromTextCommand = extractCommand(message.text, message.entities);
  const fromCaptionCommand = extractCommand(message.caption, message.caption_entities);
  const commandName = fromTextCommand.commandName ?? fromCaptionCommand.commandName;
  const commandArgs = fromTextCommand.commandArgs ?? fromCaptionCommand.commandArgs;

  return {
    chatId: message.chat.id,
    chatType: message.chat.type,
    fromId: message.from?.id,
    fromFirstName: message.from?.first_name,
    messageId: message.message_id,
    contentType: getContentType(message),
    textPreview: toPreview(message.text ?? message.caption),
    commandName,
    commandArgs,
    caption: message.caption,
    repliedMessageId: message.reply_to_message?.message_id,
    messageThreadId: message.message_thread_id,
    forwardOriginType: message.forward_origin?.type,
    mediaGroupId: message.media_group_id
  };
};

export const formatDebugReply = (content: ExtractedMessageContent): string => {
  return [
    "debug_message",
    `chat.id=${valueOrNone(content.chatId)}`,
    `chat.type=${valueOrNone(content.chatType)}`,
    `from.id=${valueOrNone(content.fromId)}`,
    `from.first_name=${valueOrNone(content.fromFirstName)}`,
    `message_id=${valueOrNone(content.messageId)}`,
    `content_type=${valueOrNone(content.contentType)}`,
    `text_preview=${valueOrNone(content.textPreview)}`,
    `command=${valueOrNone(content.commandName)}`,
    `command_args=${valueOrNone(content.commandArgs)}`,
    `caption=${valueOrNone(content.caption)}`,
    `reply_to_message_id=${valueOrNone(content.repliedMessageId)}`,
    `message_thread_id=${valueOrNone(content.messageThreadId)}`,
    `forward_origin_type=${valueOrNone(content.forwardOriginType)}`,
    `media_group_id=${valueOrNone(content.mediaGroupId)}`
  ].join("\n");
};

export const formatStartReply = (message: TelegramMessage, botName: string): string => {
  const extracted = extractMessageContent(message);
  const payload = extracted.commandName === "start" ? extracted.commandArgs : undefined;
  const chatId = String(message.chat.id);

  return [
    `Hello from ${botName}.`,
    `chat.id=${chatId}`,
    `chat.type=${message.chat.type}`,
    "Put this chat id into settings.json:",
    `"allowed_chats": { "${chatId}": {} }`,
    `start_payload=${valueOrNone(payload)}`
  ].join("\n");
};
