# Pigeon 回复风格规范

> Scope: 所有 bot 发出的消息——系统文案、命令回复、状态提示，以及通过 system prompt 约束的 AI 生成内容。
> Purpose: 保证整个 bot 的视觉语言统一，用户无论收到哪种消息都能感受到一致的风格。

---

## 原则

**先有标准，再有文案。** 任何新场景都应从本规范推导，不得临时拍脑袋。标准的目标是让未来的任何新场景都能得出一致的结果。

---

## 一、标签语义规范

Telegram HTML 仅支持白名单标签，所有回复使用 `parse_mode: "HTML"`。

| 标签 | 使用场景 | 禁止场景 |
|------|----------|----------|
| `<b>text</b>` | 消息标题、关键术语 | 长句强调、整段文字 |
| `<code>value</code>` | 命令、路径、配置值、变量名、单行技术字符串 | 多行代码、普通文本 |
| `<pre>block</pre>` | 多行代码块、配置示例、命令输出 | 单行内容 |
| `<pre><code class="language-xxx">block</code></pre>` | 带语法高亮的代码块 | — |
| `<blockquote>text</blockquote>` | 工具调用列表、进度内容、辅助说明 | 主要信息、标题 |
| `<a href="url">text</a>` | 有实际 URL 的链接 | 无 URL 的伪链接 |

**禁止使用**：`<i>` `<em>` `<u>` `<s>` `<strike>` `<del>` 及任何不在白名单内的标签。换行使用 `\n`，不使用 `<br>`。

---

## 二、Emoji 语义体系

| 语义 | Emoji | 触发场景 |
|------|-------|----------|
| 处理中 | ⏳ | 任务运行、等待 |
| 停止 | ⏹ | 任务被中断 |
| 品牌/就绪 | 🐦 | 启动成功、命令列表 |
| 警告/限制 | ⚠️ | 不支持、需注意 |
| 错误/失败 | ❌ | 执行出错 |
| 信息 | ℹ️ | 中性状态说明 |
| 授权 | 🔒 | 权限相关 |

**Emoji 位置**：放在 `<b>` 标题内，紧跟开标签后接一个空格：`<b>⏳ 正在处理</b>`。

---

## 三、排版规范

- 标题与正文之间：空一行（`\n\n`）
- 正文与代码块/引用块之间：空一行
- 列表项：紧凑排列，使用 `• ` 或 `- ` 作为项目符号
- 命令列表：`<code>/cmd</code> — 说明`（破折号 `—`，命令名用 `<code>`）

**结构层级**：

```text
<b>EMOJI 标题</b>                          ← 必有
\n\n
正文说明                                    ← 可选
\n\n
<blockquote>辅助/列表内容</blockquote>       ← 可选
\n\n
<pre>代码块</pre>                            ← 可选
```

---

## 四、转义规则

所有动态内容插入 HTML 前必须经过 `escapeHtml()`（位于 `src/telegram.ts`）：

| 字符 | 替换为 |
|------|--------|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |

---

## 五、系统状态文案

| 场景 | 文案 |
|------|------|
| 进度占位（初始） | `<b>⏳ 正在处理</b>` |
| 进度占位（追加工具） | `<b>⏳ 正在处理</b>\n\n<blockquote>→ 工具名\n→ 工具名</blockquote>` |
| 流式回复占位 | `▌` |
| 已停止 | `<b>⏹ 已停止</b>` |
| 忙碌 | `<b>⏳ 正在处理上一条消息</b>\n\n请稍候，或发送 /stop 取消当前任务。` |
| 不支持消息类型 | `<b>⚠️ 无法处理此消息</b>\n\n仅支持纯文字消息，请发送文字内容。` |
| 处理失败 | `<b>❌ 处理失败</b>\n\n任务执行时出错，请稍后重试。` |
| 空回复 | `<b>ℹ️ 无回复内容</b>` |
| 无任务可停止 | `<b>ℹ️ 没有正在运行的任务</b>` |

---

## 六、命令回复

### /start（已授权）

```html
<b>🐦 Pigeon 已就绪</b>

当前会话已启用。发送消息开始，或使用 /help 查看可用命令。
```

### /start（未授权）

```html
<b>🔒 未授权访问</b>

当前会话尚未启用。请联系管理员在 <code>settings.json</code> 中添加：

<pre>"allowed_chats": {
  "CHAT_ID": {}
}</pre>

当前聊天的 ID 为 <code>CHAT_ID</code>。
```

注：`<pre>` 内不嵌套 `<code>`（Telegram 只允许 `<pre><code class="language-xxx">` 这一种嵌套）。

### /help

```html
<b>🐦 Pigeon</b>

<code>/start</code> — 启动 Pigeon
<code>/help</code> — 查看可用命令
<code>/stop</code> — 停止当前任务

直接发送消息即可与 AI 对话。
```

---

## 七、AI 回复格式约束

通过 system prompt 的格式规范段落约束 AI 生成内容，使其与 bot 系统文案保持视觉一致。

**注意**：system prompt 语言约定为英文（见第八节），以下约束块直接以英文写入 system prompt：

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
Use \n for line breaks (not <br>). Use "- " or "• " for list items.
Keep responses under 4096 characters. For long output, summarize inline or offer to write to a file.
```

---

## 八、语言约定

| 内容类型 | 语言 |
|----------|------|
| Bot 回复文案（系统状态、命令回复） | 中文 |
| AI 生成内容 | 由 AI 自身决定，不在此约束范围 |
| 代码注释 | 英文 |
| 日志（logInfo/logError） | 英文（结构化键值对） |
| System prompt（发给 AI） | 英文 |
| 测试描述（it/describe） | 中文 |

---

## 九、消息长度

单条消息上限 4096 字符。超出时分片：第一片编辑占位消息，后续片段作为新消息发送。
分片逻辑在 `src/telegram.ts` 的 `splitText()` 中实现，勿绕过。
