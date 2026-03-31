# Pigeon M2 最小配置

## 1. `.env`

复制模板：

```bash
cp .env.example .env
```

必填：

- `TELEGRAM_BOT_TOKEN`
- 当前 `ai.provider` 对应的 API key

常用映射：

| `ai.provider` | `.env` 变量 |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| `google` | `GEMINI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |

示例：

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
OPENROUTER_API_KEY=your_openrouter_key
KIMI_API_KEY=your_kimi_key
```

## 2. `settings.json`

复制模板：

```bash
cp settings.example.json settings.json
```

当前结构：

```json
{
  "$schema": "./settings.schema.json",
  "telegram": {
    "proxy": "socks5://127.0.0.1:7890",
    "explicit_only": true,
    "allowed_chats": {
      "CHAT_ID_HERE": {}
    }
  },
  "ai": {
    "proxy": "",
    "provider": "openrouter",
    "model": "openai/gpt-5.4-mini"
  },
  "sandbox": "host"
}
```

必须理解这几个字段：

- `telegram.proxy`：只给 Telegram Bot API 用
- `ai.proxy`：只给 AI provider 出站请求用
- `ai.provider` / `ai.model`：当前启用的模型
- `sandbox`：M2 默认用 `host`

不要把 `TELEGRAM_BOT_TOKEN` 写进 `settings.json`。

## 3. `ai.proxy` 什么时候填

- `Kimi` 当前验证可直连：可以保持 `"proxy": ""`
- `OpenRouter` 当前环境需要代理：应显式填代理 URL

例如：

```json
"ai": {
  "proxy": "socks5://127.0.0.1:7890",
  "provider": "openrouter",
  "model": "openai/gpt-5.4-mini"
}
```

如果切到 Kimi：

```json
"ai": {
  "proxy": "",
  "provider": "kimi-coding",
  "model": "k2p5"
}
```

## 4. 启动

```bash
npm install
npm start
```

正常启动日志应包含：

```text
[pigeon] Telegram bot initialized ...
[pigeon] Registered Telegram commands commands=start,help,stop
[pigeon] Telegram host started ...
```

## 5. 最常见错误

### `Missing TELEGRAM_BOT_TOKEN environment variable`

说明项目根目录 `.env` 没有被正确读取，或者没有这行：

```bash
TELEGRAM_BOT_TOKEN=...
```

### provider 改了但 key 没改

例如把 `ai.provider` 改成 `kimi-coding`，但 `.env` 里没有 `KIMI_API_KEY`，就一定会失败。
