# Pigeon M2 配置与启动指南

Pigeon M2 是一个运行在 Telegram 上的持久化 agent host。

它不是一个只会回显模型文本的临时 chatbot，而是一个会为每个 chat 建立独立工作区、保存上下文、读取 memory / skills、并通过工具执行真实任务的 Telegram bot。

这份文档只讲一件事：

> 如何把当前仓库配置到可以真正启动，并完成第一次可验证的对话。

---

## 1. 先理解三类文件

Pigeon M2 启动时会用到 3 类文件：

| 文件 | 作用 | 是否由用户编辑 |
| --- | --- | --- |
| `.env` | 放 secrets，例如 `TELEGRAM_BOT_TOKEN` 和模型 provider 的 API key | 是 |
| `settings.json` | 放宿主配置，例如 `ai.provider`、`ai.model`、`sandbox`、`allowed_chats` | 是 |
| `data/agent-runtime.json` | agent runtime 的内部状态文件，由运行时自动维护 | 否 |

最重要的边界：

- `TELEGRAM_BOT_TOKEN` **不在** `settings.json` 里
- `TELEGRAM_BOT_TOKEN` 来自环境变量，或项目根目录的 `.env`
- `data/agent-runtime.json` 是内部文件，不是用户配置文件

---

## 2. 安装依赖

```bash
npm install
```

---

## 3. 配置 `.env`

先复制模板：

```bash
cp .env.example .env
```

然后编辑 `.env`：

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here

# 按你选择的 provider 补对应 key
# OPENAI_API_KEY=your_openai_api_key
# ANTHROPIC_API_KEY=your_anthropic_api_key
# GEMINI_API_KEY=your_gemini_api_key
```

### 3.1 `TELEGRAM_BOT_TOKEN` 从哪里来

1. 在 Telegram 里联系 `@BotFather`
2. 发送 `/newbot`
3. 按提示创建 bot
4. 拿到类似下面格式的 token：

```text
123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

把它填到 `.env` 里的 `TELEGRAM_BOT_TOKEN=` 后面。

### 3.2 什么时候需要 provider API key

`settings.json` 里的 `ai.provider` 决定你需要哪个 env var。

当前仓库的示例模板直接给了这些常见 key：

| `ai.provider` 示例 | 你通常需要提供的 env var |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` / Gemini 相关 provider 值 | `GEMINI_API_KEY` |

如果你改用别的 provider，请同时确认：

- `ai.provider` 的值和 `pi-ai` 支持的 provider 名称一致
- 对应的 API key 也已经放进 `.env`

---

## 4. 配置 `settings.json`

先复制模板：

```bash
cp settings.example.json settings.json
```

然后编辑成类似这样：

```json
{
  "$schema": "./settings.schema.json",
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "sandbox": "host",
  "telegram": {
    "proxy": ""
  },
  "explicit_only": true,
  "allowed_chats": {
    "CHAT_ID_HERE": {}
  }
}
```

### 4.1 每个字段是什么意思

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `ai.provider` | 是 | 模型 provider 名称 |
| `ai.model` | 是 | 模型名称 |
| `sandbox` | 是 | M2 默认填 `host` |
| `telegram.proxy` | 否 | 不走代理就留空字符串 |
| `explicit_only` | 是 | 是否要求显式触发才处理消息 |
| `allowed_chats` | 是 | 允许访问 bot 的 chat 列表 |

### 4.2 `sandbox` 该怎么填

M2 的默认模式就是：

```json
"sandbox": "host"
```

虽然底层保留了 Docker 抽象，但当前这一步配置和文档都应优先按 `host` 使用。

### 4.3 `allowed_chats` 怎么填

`allowed_chats` 的 key 是 Telegram chat ID。

例如：

```json
"allowed_chats": {
  "123456789": {},
  "-1009876543210": {
    "explicit_only": false
  }
}
```

获取 chat ID 的简单方法：

1. 在 Telegram 联系 `@userinfobot`
2. 它会回复你的用户 ID
3. 如果你用群聊，还需要拿到那个群的 chat ID

如果当前 chat 不在 `allowed_chats` 里，普通消息不会被处理。

---

## 5. 启动

直接运行：

```bash
npm start
```

如果配置正确，你会看到类似下面的日志：

```text
[pigeon] Initializing Telegram host ...
[pigeon] Telegram bot initialized ...
[pigeon] Registered Telegram commands commands=start,help,stop
[pigeon] Telegram host started ...
```

如果你看到的是：

```text
Missing TELEGRAM_BOT_TOKEN environment variable
```

说明启动时没有读到 `.env` 里的 token，直接去看文档后面的排查章节。

---

## 6. 第一次验证怎么做

建议按这个顺序验证：

1. 在已授权 chat 里发送一条普通文本消息
2. 预期 bot 先发占位消息：`_⏳ 正在处理..._`
3. 随后占位消息会被更新成最终回复
4. 检查工作区是否已经创建：

```bash
ls data
ls data/chat-<your-chat-id>
```

你至少会逐步看到这些文件：

- `log.jsonl`
- `context.jsonl`
- `agent-runtime.json` 会出现在 `data/` 下

如果后续你自己创建或 agent 写入，还可能出现：

- `data/MEMORY.md`
- `data/chat-<id>/MEMORY.md`
- `data/skills/`
- `data/chat-<id>/skills/`

### 6.1 验证重启续接

1. 先发：`你好，请记住我叫小明`
2. 停掉进程，再重新 `npm start`
3. 在同一 chat 发：`我叫什么名字？`

预期：回复里应能提到之前的上下文。

### 6.2 验证 `/stop`

1. 发一条会触发长任务的消息，例如：`请执行 sleep 30`
2. 立刻发 `/stop`

预期：

- 当前占位消息更新为 `_已停止。_`
- 终端会出现被 abort 的运行日志

### 6.3 验证 single-flight

1. 快速连续发两条文本

预期：

- 第一条正常进入处理
- 第二条收到忙碌提示：`_已在处理上一条消息，请等待或发送 /stop 取消。_`

### 6.4 验证非文本输入

发送一条纯贴纸或不带 text / caption 的消息。

预期：

```text
_目前只支持文字消息。_
```

---

## 7. 常见错误

### 7.1 `Missing TELEGRAM_BOT_TOKEN environment variable`

这是最常见的启动错误。

按这个顺序排查：

1. 确认项目根目录存在 `.env`

```bash
ls -la .env
```

2. 确认 `.env` 里真的有这一行

```bash
grep TELEGRAM_BOT_TOKEN .env
```

3. 确认没有把 token 写进 `settings.json` 却忘了写 `.env`
4. 确认你是在项目根目录运行 `npm start`
5. 确认 token 后面不是空值，也没有多余引号

正确写法：

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

不要写成：

```bash
TELEGRAM_BOT_TOKEN="123456789:ABCdef..."
```

### 7.2 `Settings file not found: settings.json`

说明你还没有创建项目根的 `settings.json`。

直接复制模板：

```bash
cp settings.example.json settings.json
```

### 7.3 `Invalid settings: ai.provider must be a non-empty string`

说明 `settings.json` 里缺了 `ai.provider` 或写成了空字符串。

同理，`ai.model`、`sandbox`、`explicit_only`、`allowed_chats` 也都必须满足 schema。

### 7.4 Bot 启动了，但不回消息

重点检查：

1. 当前 chat ID 是否在 `allowed_chats` 里
2. `explicit_only` 是否为 `true`
3. 如果 `explicit_only` 为 `true`，你是不是没有显式触发 bot
4. 终端里是否有 provider API key 相关报错

### 7.5 模型 provider 报错

重点检查：

1. `ai.provider` 是否和你提供的 API key 对应
2. `ai.model` 是否是该 provider 可用的模型名
3. `.env` 是否提供了对应的 key

---

## 8. `data/` 目录里真正有什么

当前实现下，核心结构是：

```text
data/
├── agent-runtime.json
├── MEMORY.md                # 可选，用户或 agent 后续创建
├── skills/                  # 可选，用户后续创建
└── chat-<chat-id>/
    ├── log.jsonl
    ├── context.jsonl
    ├── MEMORY.md            # 可选
    └── skills/              # 可选
```

其中：

- `log.jsonl` 是原始消息流水
- `context.jsonl` 是 runtime 使用的上下文层
- `agent-runtime.json` 是内部运行时状态

如果你只是想配置 bot，通常只需要关心：

- `.env`
- `settings.json`
- `data/chat-<id>/log.jsonl`（排查时很有用）

---

## 9. 命令列表

当前注册的 Telegram 命令是：

- `/start`
- `/help`
- `/stop`

其中 `/stop` 会在当前 chat 有活跃任务时立即 abort；没有活跃任务时，会回复：

```text
_没有正在进行的任务。_
```

---

## 10. 建议的最小成功路径

如果你只想尽快跑通，照下面做：

1. `npm install`
2. `cp .env.example .env`
3. 在 `.env` 填 `TELEGRAM_BOT_TOKEN` 和对应 provider key
4. `cp settings.example.json settings.json`
5. 在 `settings.json` 填：
   - `ai.provider`
   - `ai.model`
   - `allowed_chats`
6. 保持 `sandbox` 为 `host`
7. 运行 `npm start`
8. 在已授权 Telegram chat 里发一条文本消息

如果这 8 步走通，说明当前仓库已经完成基本配置。
