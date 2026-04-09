import type { Context } from "grammy";
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

export interface TelegramCommand {
  commandName: string | undefined;
  commandArgs: string | undefined;
}

declare const telegramHtmlBrand: unique symbol;

export type TelegramHtml = string & { readonly [telegramHtmlBrand]: true };
export type TelegramReply = TelegramHtml;

export const SYSTEM_COMMANDS = [
  {
    command: "start",
    description: "启动 Pigeon"
  },
  {
    command: "help",
    description: "查看可用命令"
  },
  {
    command: "stop",
    description: "停止当前任务"
  }
] as const;

export type MessageHandlingDecisionReason =
  | "unauthorized_chat"
  | "non_user_content"
  | "allowed_chat"
  | "explicit_trigger"
  | "explicit_gate";

export interface MessageHandlingDecision {
  shouldHandle: boolean;
  reason: MessageHandlingDecisionReason;
}

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

export const isChatAllowed = (
  chatId: number,
  allowedChats: Readonly<Record<string, unknown>> | ReadonlySet<string>
): boolean => {
  const key = String(chatId);
  if (allowedChats instanceof Set) {
    return allowedChats.has(key);
  }
  return key in allowedChats;
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
  return getMessageHandlingDecision(message, options).shouldHandle;
};

export const getMessageHandlingDecision = (
  message: TelegramMessage,
  options: ShouldHandleMessageOptions
): MessageHandlingDecision => {
  if (!isChatAllowed(message.chat.id, options.allowedChats)) {
    return {
      shouldHandle: false,
      reason: "unauthorized_chat"
    };
  }

  if (!isUserContentMessage(message)) {
    return {
      shouldHandle: false,
      reason: "non_user_content"
    };
  }

  if (!options.explicitOnly) {
    return {
      shouldHandle: true,
      reason: "allowed_chat"
    };
  }

  if (
    isExplicitTrigger(message, {
      botId: options.botId,
      botUsername: options.botUsername
    })
  ) {
    return {
      shouldHandle: true,
      reason: "explicit_trigger"
    };
  }

  return {
    shouldHandle: false,
    reason: "explicit_gate"
  };
};

const NONE = "(none)";
const PREVIEW_LIMIT = 200;

const asTelegramHtml = (text: string): TelegramHtml => text as TelegramHtml;

const escapeHtml = (value: string): string => {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
};

const ENTITY_RE = /^&(?:[a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/;
const CODE_CLASS_RE = /^language-[a-z0-9_+-]+$/;

type HtmlTagName = "b" | "code" | "pre" | "blockquote";
type HtmlToken =
  | { kind: "text"; raw: string }
  | { kind: "tag"; raw: string; name: HtmlTagName; closing: boolean };

type OpenTag = { name: HtmlTagName; open: string; close: string };

const parseAllowedTag = (rawTag: string): HtmlToken | undefined => {
  if (rawTag === "<b>") return { kind: "tag", raw: rawTag, name: "b", closing: false };
  if (rawTag === "</b>") return { kind: "tag", raw: rawTag, name: "b", closing: true };
  if (rawTag === "<pre>") return { kind: "tag", raw: rawTag, name: "pre", closing: false };
  if (rawTag === "</pre>") return { kind: "tag", raw: rawTag, name: "pre", closing: true };
  if (rawTag === "<code>") return { kind: "tag", raw: rawTag, name: "code", closing: false };
  if (rawTag === "</code>") return { kind: "tag", raw: rawTag, name: "code", closing: true };
  if (rawTag === "<blockquote>") return { kind: "tag", raw: rawTag, name: "blockquote", closing: false };
  if (rawTag === "</blockquote>") return { kind: "tag", raw: rawTag, name: "blockquote", closing: true };

  const codeClassMatch = /^<code class="([^"]+)">$/.exec(rawTag);
  if (codeClassMatch && CODE_CLASS_RE.test(codeClassMatch[1]!)) {
    return { kind: "tag", raw: rawTag, name: "code", closing: false };
  }

  return undefined;
};

const tokenizeTelegramHtml = (input: string): HtmlToken[] => {
  const tokens: HtmlToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;

    if (ch === "<") {
      const end = input.indexOf(">", i + 1);
      if (end !== -1) {
        const rawTag = input.slice(i, end + 1);
        const tag = parseAllowedTag(rawTag);
        if (tag) {
          tokens.push(tag);
          i = end + 1;
          continue;
        }
        tokens.push({ kind: "text", raw: escapeHtml(rawTag) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "&") {
      const entity = input.slice(i).match(ENTITY_RE)?.[0];
      if (entity) {
        tokens.push({ kind: "text", raw: entity });
        i += entity.length;
        continue;
      }
    }

    tokens.push({ kind: "text", raw: escapeHtml(ch) });
    i += 1;
  }
  return tokens;
};

export const normalizeTelegramHtml = (input: string): TelegramHtml => {
  const result: string[] = [];
  const stack: OpenTag[] = [];

  for (const token of tokenizeTelegramHtml(input)) {
    if (token.kind === "text") {
      result.push(token.raw);
      continue;
    }

    if (!token.closing) {
      stack.push({ name: token.name, open: token.raw, close: `</${token.name}>` });
      result.push(token.raw);
      continue;
    }

    if (stack.length > 0 && stack.at(-1)?.name === token.name) {
      result.push(token.raw);
      stack.pop();
    } else {
      result.push(escapeHtml(token.raw));
    }
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    result.push(stack[i]!.close);
  }

  return asTelegramHtml(result.join(""));
};

const closeOpenTags = (stack: OpenTag[]): string => stack.slice().reverse().map((tag) => tag.close).join("");
const reopenTags = (stack: OpenTag[]): string => stack.map((tag) => tag.open).join("");

export const renderStreamingPreview = (text: string): TelegramHtml => {
  return asTelegramHtml(`${escapeHtml(text)}▌`);
};

const renderProgressReply = (lines: string[]): TelegramHtml => {
  if (lines.length === 0) {
    return asTelegramHtml("<b>⏳ 正在处理</b>");
  }
  return asTelegramHtml(`<b>⏳ 正在处理</b>\n\n<blockquote>${lines.join("\n")}</blockquote>`);
};

const code = (value: string): string => {
  return `<code>${escapeHtml(value)}</code>`;
};

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

const extractCommandFromSource = (
  sourceText: string | undefined,
  entities: TelegramEntity[] | undefined
): TelegramCommand & { addressedBotUsername: string | undefined } => {
  if (!sourceText || !entities || entities.length === 0) {
    return { commandName: undefined, commandArgs: undefined, addressedBotUsername: undefined };
  }

  const commandEntity = entities.find((entity) => entity.type === "bot_command");
  if (!commandEntity) {
    return { commandName: undefined, commandArgs: undefined, addressedBotUsername: undefined };
  }

  const rawCommand = sourceText
    .slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
    .trim();
  if (!rawCommand.startsWith("/")) {
    return { commandName: undefined, commandArgs: undefined, addressedBotUsername: undefined };
  }

  const normalizedCommandText = rawCommand.slice(1);
  const [normalizedCommand, addressedBotUsername] = normalizedCommandText.split("@");
  const argsRaw = sourceText.slice(commandEntity.offset + commandEntity.length).trim();
  return {
    commandName: normalizedCommand || undefined,
    commandArgs: argsRaw || undefined,
    addressedBotUsername: addressedBotUsername?.toLowerCase() || undefined
  };
};

const extractCommandHeaderFromSource = (
  sourceText: string | undefined,
  entities: TelegramEntity[] | undefined
): TelegramCommand & { addressedBotUsername: string | undefined } => {
  if (!sourceText || !entities || entities.length === 0) {
    return { commandName: undefined, commandArgs: undefined, addressedBotUsername: undefined };
  }

  const commandEntity = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!commandEntity) {
    return { commandName: undefined, commandArgs: undefined, addressedBotUsername: undefined };
  }

  return extractCommandFromSource(sourceText, [commandEntity]);
};

export const extractCommand = (message: TelegramMessage): TelegramCommand => {
  const fromTextCommand = extractCommandFromSource(message.text, message.entities);
  const fromCaptionCommand = extractCommandFromSource(message.caption, message.caption_entities);

  return {
    commandName: fromTextCommand.commandName ?? fromCaptionCommand.commandName,
    commandArgs: fromTextCommand.commandArgs ?? fromCaptionCommand.commandArgs
  };
};

export const extractCommandForBot = (
  message: TelegramMessage,
  botUsername: string | undefined
): TelegramCommand => {
  const fromTextCommand = extractCommandHeaderFromSource(message.text, message.entities);
  const fromCaptionCommand = extractCommandHeaderFromSource(message.caption, message.caption_entities);

  const command = fromTextCommand.commandName ? fromTextCommand : fromCaptionCommand;
  if (!command.commandName) {
    return { commandName: undefined, commandArgs: undefined };
  }

  if (!command.addressedBotUsername) {
    return {
      commandName: command.commandName,
      commandArgs: command.commandArgs
    };
  }

  if (!botUsername || command.addressedBotUsername !== botUsername.toLowerCase()) {
    return { commandName: undefined, commandArgs: undefined };
  }

  return {
    commandName: command.commandName,
    commandArgs: command.commandArgs
  };
};

const valueOrNone = (value: string | number | undefined): string => {
  if (value === undefined || value === "") {
    return NONE;
  }
  return String(value);
};

export const extractMessageContent = (message: TelegramMessage): ExtractedMessageContent => {
  const command = extractCommand(message);

  return {
    chatId: message.chat.id,
    chatType: message.chat.type,
    fromId: message.from?.id,
    fromFirstName: message.from?.first_name,
    messageId: message.message_id,
    contentType: getContentType(message),
    textPreview: toPreview(message.text ?? message.caption),
    commandName: command.commandName,
    commandArgs: command.commandArgs,
    caption: message.caption,
    repliedMessageId: message.reply_to_message?.message_id,
    messageThreadId: message.message_thread_id,
    forwardOriginType: message.forward_origin?.type,
    mediaGroupId: message.media_group_id
  };
};

export const formatDebugReply = (content: ExtractedMessageContent): TelegramReply => {
  return asTelegramHtml(`<pre>${escapeHtml(
    [
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
    ].join("\n")
  )}</pre>`);
};

export const formatStartReply = (
  message: TelegramMessage,
  botName: string,
  isAuthorized: boolean
): TelegramReply => {
  const command = extractCommand(message);
  const lines = [];

  if (isAuthorized) {
    lines.push(
      "<b>🐦 Pigeon 已就绪</b>\n",
      "当前会话已启用。发送消息开始，或使用 /help 查看可用命令。"
    );
  } else {
    const chatId = escapeHtml(String(message.chat.id));
    lines.push(
      "<b>🔒 未授权访问</b>\n",
      `当前会话尚未启用。请联系管理员在 <code>settings.json</code> 中添加：\n`,
      `<pre>"allowed_chats": {\n  "${chatId}": {}\n}</pre>\n`,
      `当前聊天的 ID 为 <code>${chatId}</code>。`
    );
  }

  if (command.commandName === "start" && command.commandArgs) {
    lines.push(`\nstart_payload: <code>${escapeHtml(command.commandArgs)}</code>`);
  }

  return asTelegramHtml(lines.join("\n"));
};

export const formatHelpReply = (botName: string): TelegramReply => {
  return asTelegramHtml([
    `<b>🐦 Pigeon</b>\n`,
    ...SYSTEM_COMMANDS.map((command) => `<code>/${command.command}</code> — ${escapeHtml(command.description)}`),
    `\n直接发送消息即可与 AI 对话。`
  ].join("\n"));
};

export interface TelegramResponseContext {
  sendInitial(): Promise<void>;
  updateProgress(label: string): Promise<void>;
  appendDelta(delta: string): Promise<void>;
  sendFinal(text: TelegramHtml): Promise<void>;
  markStopped(): Promise<void>;
}

export const TELEGRAM_MAX_LENGTH = 4096;

export const splitText = (text: TelegramHtml): TelegramHtml[] => {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const tokens = tokenizeTelegramHtml(text);
  const parts: TelegramHtml[] = [];
  const stack: OpenTag[] = [];
  let current = "";

  const pushCurrent = (): void => {
    const closed = current + closeOpenTags(stack);
    if (closed !== "") {
      parts.push(asTelegramHtml(closed));
    }
    current = reopenTags(stack);
  };

  for (const token of tokens) {
    if (token.kind === "tag") {
      if (current.length + token.raw.length > TELEGRAM_MAX_LENGTH && current !== "") {
        pushCurrent();
      }
      current += token.raw;
      if (!token.closing) {
        stack.push({ name: token.name, open: token.raw, close: `</${token.name}>` });
      } else if (stack.at(-1)?.name === token.name) {
        stack.pop();
      }
      continue;
    }

    let remaining = token.raw;
    while (remaining.length > 0) {
      const available = TELEGRAM_MAX_LENGTH - current.length - closeOpenTags(stack).length;
      if (available <= 0 && current !== "") {
        pushCurrent();
        continue;
      }
      if (remaining.length <= available) {
        current += remaining;
        remaining = "";
        continue;
      }

      let cut = available;
      const entityStart = remaining.lastIndexOf("&", available - 1);
      if (entityStart !== -1) {
        const entityEnd = remaining.indexOf(";", entityStart);
        if (entityEnd !== -1 && entityEnd >= available) {
          cut = entityStart;
        }
      }
      if (cut <= 0) {
        pushCurrent();
        continue;
      }

      current += remaining.slice(0, cut);
      remaining = remaining.slice(cut);
      pushCurrent();
    }
  }

  if (current !== "") {
    parts.push(asTelegramHtml(current + closeOpenTags(stack)));
  }

  return parts;
};

export const createResponseContext = (ctx: Context): TelegramResponseContext => {
  let messageId: number | undefined;
  let progressLines: string[] = [];
  let lastProgressEdit = 0;
  let pendingProgressTimeout: NodeJS.Timeout | undefined;

  let streamingText = "";
  let inStreamingMode = false;
  let lastStreamEdit = 0;
  let pendingStreamTimeout: NodeJS.Timeout | undefined;

  const EDIT_INTERVAL_MS = 1000;

  const doEdit = async (text: TelegramHtml): Promise<void> => {
    if (!messageId) return;
    try {
      await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { parse_mode: "HTML" });
    } catch {}
  };

  const flushProgress = async (): Promise<void> => {
    if (pendingProgressTimeout) { clearTimeout(pendingProgressTimeout); pendingProgressTimeout = undefined; }
    lastProgressEdit = Date.now();
    await doEdit(renderProgressReply(progressLines));
  };

  const flushStream = async (): Promise<void> => {
    if (pendingStreamTimeout) { clearTimeout(pendingStreamTimeout); pendingStreamTimeout = undefined; }
    lastStreamEdit = Date.now();
    await doEdit(renderStreamingPreview(streamingText));
  };

  const cancelPending = (): void => {
    if (pendingProgressTimeout) { clearTimeout(pendingProgressTimeout); pendingProgressTimeout = undefined; }
    if (pendingStreamTimeout) { clearTimeout(pendingStreamTimeout); pendingStreamTimeout = undefined; }
  };

  return {
    async sendInitial() {
      if (messageId) return;
      const msg = await ctx.reply(renderProgressReply(progressLines), { parse_mode: "HTML" });
      messageId = msg.message_id;
    },

    async updateProgress(label: string) {
      if (!messageId || inStreamingMode) return;
      progressLines.push(`→ ${escapeHtml(label)}`);
      const timeSince = Date.now() - lastProgressEdit;
      if (timeSince >= EDIT_INTERVAL_MS) {
        await flushProgress();
      } else if (!pendingProgressTimeout) {
        pendingProgressTimeout = setTimeout(() => { pendingProgressTimeout = undefined; flushProgress().catch(() => {}); }, EDIT_INTERVAL_MS - timeSince);
      }
    },

    async appendDelta(delta: string) {
      if (!messageId) return;
      if (!inStreamingMode) {
        inStreamingMode = true;
        cancelPending();
        streamingText = "";
        await doEdit(renderStreamingPreview(""));
      }
      streamingText += delta;
      const timeSince = Date.now() - lastStreamEdit;
      if (timeSince >= EDIT_INTERVAL_MS) {
        await flushStream();
      } else if (!pendingStreamTimeout) {
        pendingStreamTimeout = setTimeout(() => { pendingStreamTimeout = undefined; flushStream().catch(() => {}); }, EDIT_INTERVAL_MS - timeSince);
      }
    },

    async sendFinal(text: TelegramHtml) {
      cancelPending();
      const parts = splitText(text);
      const first = parts[0] ?? "";
      if (messageId) {
        await doEdit(first);
      } else {
        await ctx.reply(first, { parse_mode: "HTML" });
      }
      for (let i = 1; i < parts.length; i++) {
        await ctx.reply(parts[i]!, { parse_mode: "HTML" });
      }
    },

    async markStopped() {
      cancelPending();
      if (!messageId) return;
      await doEdit(asTelegramHtml("<b>⏹ 已停止</b>"));
    }
  };
};
