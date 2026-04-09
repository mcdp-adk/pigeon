# Pigeon

一个 Telegram-first 的个人 agent 宿主。

## 命令

| 命令 | 说明 |
|------|------|
| `/start` | 查看当前状态与配置指引 |
| `/help` | 显示可用命令 |
| `/stop` | 停止当前任务 |

在已启用的 chat 中，可通过命令、@提及或回复机器人发起对话；若该 chat 关闭显式触发，也可直接发送消息。

## 配置

需要 `TELEGRAM_BOT_TOKEN` + 至少一个 AI provider 的 API key。

### `.env`

```bash
cp .env.example .env
```

当前仅支持 env var 认证，不支持 OAuth。

| 环境变量 | `ai.provider` | 备注 |
|---------|---------------|------|
| `TELEGRAM_BOT_TOKEN` | — | 必须，从 @BotFather 获取 |
| `OPENAI_API_KEY` | `openai` | |
| `ANTHROPIC_API_KEY` | `anthropic` | |
| `ANTHROPIC_OAUTH_TOKEN` | `anthropic` | 优先级高于 API key |
| `GEMINI_API_KEY` | `google` | Google AI Studio |
| `GOOGLE_CLOUD_API_KEY` | `google-vertex` | 或用 ADC，需 `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` |
| `AZURE_OPENAI_API_KEY` | `azure-openai-responses` | 需额外 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` |
| `MISTRAL_API_KEY` | `mistral` | |
| `GROQ_API_KEY` | `groq` | |
| `CEREBRAS_API_KEY` | `cerebras` | |
| `XAI_API_KEY` | `xai` | |
| `OPENROUTER_API_KEY` | `openrouter` | |
| `KIMI_API_KEY` | `kimi-coding` | 月之暗面 Kimi，Anthropic-compatible API，非 Moonshot OpenAI 格式 |
| `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` | |
| `ZAI_API_KEY` | `zai` | 智谱 |
| `MINIMAX_API_KEY` | `minimax` | |
| `MINIMAX_CN_API_KEY` | `minimax-cn` | 国内 endpoint |
| `HF_TOKEN` | `huggingface` | |
| `OPENCODE_API_KEY` | `opencode` / `opencode-go` | |
| `COPILOT_GITHUB_TOKEN` | `github-copilot` | 也接受 `GH_TOKEN` / `GITHUB_TOKEN` |
| AWS 凭证 | `amazon-bedrock` | 支持 `AWS_PROFILE`、IAM key、Bearer Token、ECS/IRSA 等 |

### `settings.json`

```bash
cp settings.example.json settings.json
```

| 配置项 | 说明 |
|--------|------|
| `telegram.proxy` | Telegram Bot API 代理（如 `socks5://127.0.0.1:7890`） |
| `telegram.explicit_only` | `true` = 只响应 @提及 / 回复 / 命令；`false` = 响应所有消息 |
| `telegram.allowed_chats` | 白名单，key 为 chat ID，value 为 `{}` 或 `{ "explicit_only": bool }` 覆盖全局 |
| `ai.proxy` | AI provider 代理 |
| `ai.provider` | 对应上表 `ai.provider` 列 |
| `ai.model` | 模型名称，取决于 provider |
| `sandbox` | `"host"` 或 `"docker:容器名"` |

## 启动

```bash
npm install
npm start
```

## 示例

```bash
# .env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
KIMI_API_KEY=sk-...
```

```jsonc
// settings.json
{
  "$schema": "./settings.schema.json",
  "telegram": {
    "proxy": "",
    "explicit_only": true,
    "allowed_chats": { "123456789": {} }
  },
  "ai": {
    "proxy": "",
    "provider": "kimi-coding",
    "model": "k2p5"
  },
  "sandbox": "host"
}
```

```bash
npm start
```
