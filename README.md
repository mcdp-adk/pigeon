# Pigeon M2 最小配置说明

如果你现在最困惑的是：

> `ai.provider` 到底对应哪个环境变量名？

那重点就是这一条：

- `settings.json` 里填的是 **provider 名称** 和 **model 名称**
- `.env` 里填的是这个 provider 对应的 **API key 环境变量**
- `TELEGRAM_BOT_TOKEN` 永远只放在 `.env`，**不要**放进 `settings.json`

---

## 1. 先看最重要的映射表

下面这张表基于当前安装的 `@mariozechner/pi-ai` `0.62.0` 自带 README 的 “Environment Variables (Node.js only)” 部分整理。

| `ai.provider` 常见值 | 需要的 env var |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN`，或 `ANTHROPIC_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`，或 `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` + ADC |
| `openrouter` | `OPENROUTER_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |
| `opencode` | `OPENCODE_API_KEY` |
| `opencode-go` | `OPENCODE_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`，或 `GH_TOKEN`，或 `GITHUB_TOKEN` |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY`，以及 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` |

如果你当前只打算用最常见的 provider，那你可以直接记下面这 4 条：

- `openai` → `OPENAI_API_KEY`
- `anthropic` → `ANTHROPIC_API_KEY`（或 `ANTHROPIC_OAUTH_TOKEN`）
- `google` → `GEMINI_API_KEY`
- `openrouter` → `OPENROUTER_API_KEY`

---

## 2. 你到底该怎么填

### 2.1 `.env`

先复制模板：

```bash
cp .env.example .env
```

如果你用 OpenAI，那么 `.env` 最少应是：

```bash
TELEGRAM_BOT_TOKEN=你的_botfather_token
OPENAI_API_KEY=你的_openai_key
```

如果你用 Anthropic，那么 `.env` 最少应是：

```bash
TELEGRAM_BOT_TOKEN=你的_botfather_token
ANTHROPIC_API_KEY=你的_anthropic_key
```

如果你用 Google Gemini，那么 `.env` 最少应是：

```bash
TELEGRAM_BOT_TOKEN=你的_botfather_token
GEMINI_API_KEY=你的_gemini_key
```

如果你用 OpenRouter，那么 `.env` 最少应是：

```bash
TELEGRAM_BOT_TOKEN=你的_botfather_token
OPENROUTER_API_KEY=你的_openrouter_key
```

### 2.2 `settings.json`

再复制模板：

```bash
cp settings.example.json settings.json
```

如果你用 OpenAI，一个最小可用示例是：

```json
{
  "$schema": "./settings.schema.json",
  "telegram": {
    "proxy": "",
    "explicit_only": true,
    "allowed_chats": {
      "CHAT_ID_HERE": {}
    }
  },
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "sandbox": "host"
}
```

如果你改用 Anthropic，只改这里：

```json
"ai": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514"
}
```

如果你改用 Google，只改这里：

```json
"ai": {
  "provider": "google",
  "model": "gemini-2.5-flash"
}
```

如果你改用 OpenRouter，只改这里：

```json
"ai": {
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4.5"
}
```

---

## 3. 哪些值是必须的

### `.env` 必须有

- `TELEGRAM_BOT_TOKEN`
- 你当前所选 `ai.provider` 对应的 API key env var

### `settings.json` 必须有

- `ai.provider`
- `ai.model`
- `sandbox`
- `telegram.explicit_only`
- `telegram.allowed_chats`
- `telegram.proxy` 可以留空字符串

### 当前 M2 推荐值

```json
"sandbox": "host"
```

---

## 4. 最容易搞错的点

### 错误 1：把 bot token 填进 `settings.json`

这是错的。

`settings.json` **不再**包含 `telegram.token`。

bot token 只能来自：

- 运行进程的环境变量
- 或项目根目录 `.env`

### 错误 2：`ai.provider` 改了，但 `.env` 里的 key 名没改

例如你把：

```json
"provider": "anthropic"
```

写进了 `settings.json`，但 `.env` 里还只有：

```bash
OPENAI_API_KEY=...
```

那就一定会失败。

### 错误 3：`.env` 文件放错目录

Pigeon 现在会从**项目根目录**加载 `.env`。

也就是说，`npm start` 在哪个目录运行，那个目录就必须同时有：

- `.env`
- `settings.json`

---

## 5. 最小启动步骤

1. 安装依赖：

```bash
npm install
```

2. 配置 `.env`
3. 配置 `settings.json`
4. 运行：

```bash
npm start
```

如果配置正确，你会看到类似：

```text
[pigeon] Initializing Telegram host ...
[pigeon] Telegram bot initialized ...
[pigeon] Registered Telegram commands commands=start,help,stop
[pigeon] Telegram host started ...
```

---

## 6. 如果你看到这个错误

```text
Missing TELEGRAM_BOT_TOKEN environment variable
```

按这个顺序排查：

1. 项目根目录是否有 `.env`

```bash
ls -la .env
```

2. `.env` 里是否真的有 token

```bash
grep TELEGRAM_BOT_TOKEN .env
```

3. 你是不是在项目根目录运行的 `npm start`
4. 你是不是只改了 `settings.json`，但根本没填 `.env`

---

## 7. 只记住这一条也够用

如果你不想看整篇文档，就记住下面这个公式：

> `settings.json` 负责告诉 Pigeon “用哪个 provider / model”，`.env` 负责给这个 provider 提供真正的 key。

也就是：

- `provider = openai` → `.env` 里要有 `OPENAI_API_KEY`
- `provider = anthropic` → `.env` 里要有 `ANTHROPIC_API_KEY`（或 `ANTHROPIC_OAUTH_TOKEN`）
- `provider = google` → `.env` 里要有 `GEMINI_API_KEY`
- `provider = openrouter` → `.env` 里要有 `OPENROUTER_API_KEY`
