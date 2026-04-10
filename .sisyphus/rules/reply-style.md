# Pigeon 回复风格规范

> Scope：所有 bot 发出的消息——系统文案、命令回复、状态提示，以及通过 system prompt 约束的 AI 生成内容。
> Purpose：保证整个 bot 的视觉语言统一，用户无论收到哪种消息都能感受到一致的风格。

---

## 一、标签语义规范

Telegram HTML 仅支持白名单标签，所有回复使用 `parse_mode: "HTML"`。

| 标签 | 使用场景 | 禁止场景 |
|------|----------|----------|
| `<b>` | 消息标题、关键术语 | 长句强调、整段文字 |
| `<code>` | 命令、路径、配置值、变量名、单行技术字符串 | 多行代码、普通文本 |
| `<pre>` | 多行代码块、配置示例、命令输出 | 单行内容 |
| `<pre><code class="language-xxx">` | 带语法高亮的代码块 | — |
| `<blockquote>` | 工具调用列表、进度内容、辅助说明 | 主要信息、标题 |
| `<a href="url">` | 有实际 URL 的链接 | 无 URL 的伪链接 |

**禁止使用**：`<i>` `<em>` `<u>` `<s>` `<strike>` `<del>` 及任何不在白名单内的标签。换行使用 `\n`，不使用 `<br>`。

---

## 二、Emoji 语义体系

每条回复的 `<b>` 标题内放置一个语义 emoji，紧跟开标签后接一个空格。

| 语义 | Emoji | 触发场景 |
|------|-------|----------|
| 处理中 | ⏳ | 任务运行、等待 |
| 停止 | ⏹ | 任务被中断 |
| 品牌 / 概览 | 🐦 | 品牌级入口（帮助、概览） |
| 警告 / 限制 | ⚠️ | 不支持、需注意 |
| 错误 / 失败 | ❌ | 执行出错 |
| 信息 | ℹ️ | 中性状态说明 |
| 配置 / 权限 | 🔒 | 权限相关、配置指引 |

**规则**：

- 同一条消息只使用一个顶级 emoji
- 多段式回复中，每个 `<b>` 段标题可各自带 emoji，但必须从上表中选取
- 不在标题以外的位置使用 emoji

---

## 三、排版规范

- 标题与正文之间：空一行（`\n\n`）
- 正文与代码块 / 引用块之间：空一行
- 列表项：紧凑排列，统一使用 `- ` 作为项目符号
- 命令列表：`<code>/cmd</code> — 说明`（全角破折号 `—`，命令名用 `<code>`）
- 中英文之间加空格：`Chat ID` 而非 `ChatID`
- 中文与数字之间加空格：`4096 字符` 而非 `4096字符`
- 中文语境使用全角标点，英文语境使用半角标点

---

## 四、转义规则

所有动态内容插入 HTML 前必须经过 `escapeHtml()`（位于 `src/telegram.ts`）：

| 字符 | 替换为 |
|------|--------|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |

`<pre>` 内部同样需要转义。`<pre>` 内不嵌套 `<code>`（Telegram 只允许 `<pre><code class="language-xxx">` 这一种嵌套）。

---

## 五、回复原型

所有 bot 回复归入以下 5 种原型。新增回复时，先确定原型，再按对应结构编写。

### 原型 A：状态通知

单次操作的即时反馈。

```text
<b>EMOJI 标题</b>

可选正文（仅当用户需要下一步操作提示时）
```

**规则**：
- 标题必须包含一个语义 emoji
- 正文最多一句话
- 当标题已完整传达信息时，可省略正文（如"已停止"、"无回复内容"）
- 不使用列表、代码块或引用块

### 原型 B：信息面板

展示结构化状态或配置信息。

```text
<b>EMOJI 总标题</b>

<b>EMOJI 段标题</b>
- 键：值
- 键：值

<b>EMOJI 段标题</b>
- 键：值
- 键：值
```

**规则**：
- 总标题可选，段标题必有
- 每个段标题带一个语义 emoji
- 列表项使用 `- ` 前缀
- 动态值用 `<code>` 包裹
- 配置示例用 `<pre>` 包裹
- 段与段之间空一行

### 原型 C：命令列表

展示可用命令。

```text
<b>EMOJI 标题</b>

<code>/cmd</code> — 说明
<code>/cmd</code> — 说明

可选尾注
```

**规则**：
- 标题带品牌 emoji（🐦）
- 每条命令占一行，格式为 `<code>/cmd</code> — 说明`
- 尾注最多一句话

### 原型 D：进度与流式预览

任务执行过程中的动态更新。

```text
<b>⏳ 标题</b>

<blockquote>→ 步骤 1\n→ 步骤 2</blockquote>
```

**规则**：
- 标题固定使用 ⏳
- 工具调用列表放在 `<blockquote>` 内，每行以 `→ ` 开头
- 无工具调用时只显示标题
- 流式文本预览使用纯文本 + `▌` 光标，不加标签
- 终态（已停止）切换为原型 A

### 原型 E：调试转储

开发者导向的原始数据输出。

```text
<pre>key=value\nkey=value</pre>
```

**规则**：
- 整条消息为单个 `<pre>` 块
- 不需要 `<b>` 标题
- 仅用于开发者调试场景，不面向普通用户
- 如果调试信息需要面向普通用户展示，必须改用原型 B

---

## 六、AI 回复格式约束

通过 system prompt 的格式规范段落约束 AI 生成内容，使其与 bot 系统文案保持视觉一致。

**注意**：system prompt 语言约定为英文，以下约束块直接以英文写入 system prompt：

```text
## Telegram Formatting (HTML)

All responses use Telegram HTML format (parse_mode: HTML).

Tag usage:
- <b>text</b>: titles, key terms (at most once per paragraph)
- <code>value</code>: commands, paths, config values, variable names
- <pre>block</pre>: multi-line code blocks, command output
- <pre><code class="language-xxx">block</code></pre>: syntax-highlighted code
- <blockquote>text</blockquote>: quoted content, supplementary notes

Forbidden: <i> <em> <u> <s> and any other tags.
Use \n for line breaks (not <br>). Use "- " for list items.
Keep responses under 4096 characters. For long output, summarize inline or offer to write to a file.
```

---

## 七、语言约定

| 内容类型 | 语言 |
|----------|------|
| Bot 回复文案（系统状态、命令回复） | 中文 |
| AI 生成内容 | 由 AI 自身决定，不在此约束范围 |
| 代码注释 | 英文 |
| 日志（logInfo / logError） | 英文（结构化键值对） |
| System prompt（发给 AI） | 英文 |
| 测试描述（it / describe） | 英文 |

---

## 八、消息长度

单条消息上限 4096 字符，caption 上限 1024 字符。超出时分片：第一片编辑占位消息，后续片段作为新消息发送。分片逻辑在 `src/telegram.ts` 的 `splitText()` 中实现，勿绕过。

预留约 100 字符给标题和分片标记。不要在代码块中间分片。

---

## 九、一致性裁决

当某条新回复不确定该怎么写时，按以下顺序判断：

1. 它属于哪种回复原型（A–E）
2. 是否需要用户下一步操作提示
3. 是否需要结构化展示
4. 是否属于开发者调试输出
5. 是否可以在不损失信息的前提下更短

若无特殊理由，优先选择：

- 最简单的原型
- 最短的可理解结构
- 最稳定的 emoji 语义
- 最少的标签种类

本规范追求的是**统一、清晰、低认知负担**，而不是"每条消息都长得一样"。
