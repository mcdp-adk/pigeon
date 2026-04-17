# Pigeon

Telegram bot 宿主：你通过 Telegram 向它发消息，它背后跑一个 AI 编码 agent，能读写本地文件、执行 shell 命令、调用你指定的 AI 模型回答你。

**前置**：Node.js ≥ 20、一个 Telegram 账号、一个可用的 AI 凭证（下方任选其一）。

## 快速开始

1. **创建 Telegram bot**：在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot`，按提示取一个名字，它会返回一段形如 `123456:ABC...` 的 token。
2. **拿到目标 chat 的 ID**（bot 只对白名单里的 chat 工作，且仅支持私聊和群组；频道目前不支持）：
   - **私聊**：在 Telegram 里找 [@userinfobot](https://t.me/userinfobot) 发 `/start`，它回复的数字就是你和 bot 私聊的 chat ID。
   - **群组**：把 bot 拉进群后，在群里对 bot 发 `/start`，bot 的回复里会打印 `Chat ID` 字段。即便该群当前没授权，bot 也会返回这个 ID 和需要写进 `telegram.allowed_chats` 的那一行映射。
3. **安装依赖**：`npm install`
4. **准备配置文件**：
   ```bash
   cp .env.example .env
   cp settings.example.json settings.json
   ```
   - 编辑 `.env`：把第 1 步的 token 填给 `TELEGRAM_BOT_TOKEN`。
   - 编辑 `settings.json`：把 `telegram.allowed_chats` 里的 `"CHAT_ID_HERE"` 替换成第 2 步拿到的 chat ID（字符串形式，两边加引号）。再按下方「settings.json」小节把 `ai.provider`、`ai.model` 改成你要用的 provider / model；不知道填什么就跑 `npm run models` 看清单。
5. **配置 AI 凭证**（三种方式任选其一）：
   - OAuth（有订阅账号时最省事）：`npm run login <provider>`，见下方「OAuth 订阅登录」。
   - 手工写入 API key：`npm run auth:set <provider>`，提示后隐藏输入。
   - 环境变量：把 provider 对应的变量（见「API key 环境变量」）加进 `.env`。
6. **启动**：`npm start`。在 Telegram 里跟 bot 聊天即可。

> **术语**  
> **provider**：AI 服务提供方（如 `openai`、`anthropic`）。  
> **model**：provider 旗下具体的模型（如 `gpt-4o-mini`、`claude-sonnet-4-5`）。  
> **API key**：provider 发给你的静态密钥。  
> **OAuth**：通过浏览器登录你的订阅账号，自动拿短期 token 并自动刷新，不需要粘贴 key。

## settings.json

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `telegram.proxy` | 字符串 | 否 | 访问 Telegram API 的代理。留空 = 直连。支持协议：`http://`、`https://`、`socks5://`、`socks5h://`。示例：`socks5://127.0.0.1:7890` |
| `telegram.explicit_only` | 布尔 | 是 | 所有 chat 的默认触发模式（每个 chat 可在 `telegram.allowed_chats` 中单独覆盖）。`true` = bot 只响应 `/命令`、@mention、以及对 bot 的回复；`false` = bot 响应该 chat 的所有消息 |
| `telegram.allowed_chats` | 对象 | 是 | 白名单。key 是 chat ID 字符串，value 是 `{}`（继承全局 `explicit_only`）或 `{"explicit_only": true}` / `{"explicit_only": false}` 单独覆盖。未列出的 chat 只能使用 `/start`、`/help`、`/stop` 这三条命令（`/start` 会回复配置指引），其他任何消息一律忽略 |
| `ai.proxy` | 字符串 | 否 | AI provider 出站代理。留空 = 直连。支持协议：`http://`、`https://`、`socks://`、`socks5://`、`socks5h://` |
| `ai.provider` | 字符串 | 是 | provider id。跑 `npm run models` 看全部合法值 |
| `ai.model` | 字符串 | 是 | model id。跑 `npm run models <provider>` 看该 provider 下全部合法值 |
| `ai.auth_path` | 字符串 | 否 | 凭证文件路径。默认 `~/.pi/pigeon/auth.json`。支持开头的 `~/` |
| `sandbox` | 字符串 | 是 | Agent 执行 shell 命令的位置。`"host"` = 直接在启动 pigeon 的这台机器上运行（有完整磁盘/网络权限，务必自己判断风险）；`"docker:<容器名>"` = 把命令 `docker exec` 到你事先启动好的容器里 |

**最小可用示例**（把 chat ID 替换成你自己的）：

```jsonc
{
  "$schema": "./settings.schema.json",
  "telegram": {
    "proxy": "",
    "explicit_only": true,
    "allowed_chats": { "123456789": {} }
  },
  "ai": {
    "proxy": "",
    "provider": "openai",
    "model": "gpt-5.4-mini"
  },
  "sandbox": "host"
}
```

## AI 凭证

Bot 在每次向模型发请求前按以下顺序查凭证，找到就用：

1. `auth.json` 里的 API key（`npm run auth:set` 写入）
2. `auth.json` 里的 OAuth token（`npm run login` 写入，过期自动刷新）
3. 环境变量

`auth.json` 每次请求前都会从磁盘重读，通过 `npm run auth:set` / `npm run login` / `npm run logout` 更新后下一次请求就生效。`.env` 与进程外环境变量只在启动时加载，改动后需要重启 bot。

### OAuth 订阅登录

以下 provider 可用浏览器登录你的订阅账号，token 由 pigeon 自动刷新：

| `ai.provider` | 说明 |
|---|---|
| `anthropic` | Claude Pro / Max |
| `openai-codex` | ChatGPT Plus / Pro（Codex） |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist（部分账号需先设好 `GOOGLE_CLOUD_PROJECT` 环境变量，登录脚本会提示） |
| `google-antigravity` | Antigravity（Gemini 3 / Claude / GPT-OSS） |

命令：`npm run login`（交互选择）或 `npm run login <provider>`。

### API key 环境变量

把变量放进 `.env` 或系统环境；或者用 `npm run auth:set <provider>` 存进 `auth.json`（优先级更高，且不写进 `.env`）：

| `ai.provider` | 环境变量 |
|---|---|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY`（或 `ANTHROPIC_OAUTH_TOKEN`，优先级更高） |
| `google` | `GEMINI_API_KEY`（Google AI Studio） |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`；或 ADC：`GOOGLE_APPLICATION_CREDENTIALS=<服务账号 JSON 路径>`（或用 `gcloud auth application-default login` 生成默认凭证文件）+ `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（或 `AZURE_OPENAI_RESOURCE_NAME`） |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `minimax-cn` | `MINIMAX_CN_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `opencode` / `opencode-go` | `OPENCODE_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`、`GH_TOKEN` 或 `GITHUB_TOKEN`（任一命中即可） |
| `amazon-bedrock` | 以下任一组合即可：<br>① `AWS_PROFILE`（读 `~/.aws/credentials` 里的 profile）<br>② `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`（IAM 静态密钥）<br>③ `AWS_BEARER_TOKEN_BEDROCK`（Bedrock API key，bearer token）<br>④ `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` 或 `AWS_CONTAINER_CREDENTIALS_FULL_URI`（ECS task role）<br>⑤ `AWS_WEB_IDENTITY_TOKEN_FILE`（EKS IRSA） |

> ADC = Application Default Credentials，Google Cloud 标准的「找不到显式 key 时用哪一套凭证」规则。  
> IAM / ECS / IRSA / Bearer Token 是 AWS 的不同身份验证方式，选一种你有的即可。

## 命令

### npm 脚本

| 命令 | 说明 |
|---|---|
| `npm start` | 启动 bot |
| `npm run dev` | 启动 bot 并监听源码变更自动重启 |
| `npm run login [<provider>]` | OAuth 登录。无参数 = 列出可登录的 provider 让你选 |
| `npm run logout <provider>` | 删除该 provider 在 `auth.json` 中的凭证（OAuth token 或 API key 均可） |
| `npm run auth:remove <provider>` | `logout` 的别名 |
| `npm run auth:set <provider> [<key>]` | 写入 / 更新一条 API key。省略 `<key>` 会提示隐藏输入 |
| `npm run auth:status` | 列出每个 provider 当前凭证来源：`api-key`（来自 auth.json）、`oauth`（来自 auth.json）、`env`（来自环境变量）、`none`（没有凭证） |
| `npm run models [<provider>]` | 列出全部合法 `ai.provider`；给一个 provider id 则列出它旗下全部合法 `ai.model` |
| `npm test` | 运行测试 |
| `npm run typecheck` | TypeScript 类型检查 |

### Telegram 内命令

| 命令 | 说明 |
|---|---|
| `/start` | 打印当前 chat ID、授权状态、触发规则。未授权的 chat 也会收到回复，其中包含可以直接粘进 `telegram.allowed_chats` 的那一行映射 |
| `/help` | 列出可用命令 |
| `/stop` | 中止当前正在进行的 agent 任务 |

**bot 会不会回应某条消息，取决于**：
1. `/start`、`/help`、`/stop` 永远会处理，不管 chat 是否授权。
2. 除上述三条命令外，chat 的 ID 不在 `telegram.allowed_chats` → 忽略。
3. 该 chat 的 `explicit_only` 为 `true`（未在 `telegram.allowed_chats` 中覆盖时继承 `telegram.explicit_only`）→ 只响应 `/命令`、@mention、以及回复 bot 消息的情况。
4. 该 chat 的 `explicit_only` 为 `false` → 响应该 chat 的全部消息。

## 数据目录

Bot 在启动 pigeon 的当前目录下创建 `./data/` 作为工作区。pigeon 启动时会自己创建 `./data/events/` 并持续监听它；其他目录则按需出现（pigeon 初次处理某个 chat 时创建 `chat-<id>/`，agent 自己决定何时生成 `MEMORY.md`、`skills/` 等）：

```
./data/
├── events/                pigeon 启动时创建，agent 在这里放定时任务 JSON 文件
├── agent-runtime.json     （可选）agent 自己改过的运行时设置（默认 provider、思考档位、主题、重试策略等）
├── MEMORY.md              （可选）跨所有 chat 的全局记忆，agent 自行维护
├── skills/                （可选）自定义 CLI 技能，agent 自行创建
└── chat-<id>/             pigeon 首次处理该 chat 时创建
    ├── log.jsonl          pigeon 写入：原始消息流水
    ├── context.jsonl      pigeon 写入：agent 完整会话上下文（用于恢复对话）
    ├── MEMORY.md          （可选）该 chat 的专属记忆，agent 自行维护
    └── skills/            （可选）该 chat 专属的技能，agent 自行创建
```

Agent 会在它认为有用的时候主动读写这些文件，也可能在 chat 目录下创建临时子目录来工作。你一般不需要手动编辑任何一个。

**完整备份 / 迁移 bot 需要以下四样**：
1. `./data/`（对话历史、上下文、agent 记忆、运行时设置、定时任务）
2. `settings.json`（本仓库根目录）
3. `.env`（至少包含 `TELEGRAM_BOT_TOKEN`，以及通过环境变量提供的任何 API key）
4. `auth.json`（默认 `~/.pi/pigeon/auth.json`，或 `ai.auth_path` 指向的路径）

Agent 执行 shell 命令的落点由 `sandbox` 决定：`"host"` 直接在本机跑，拥有完整权限；`"docker:<容器名>"` 则把命令通过 `docker exec` 送进你预先启动好的容器，适合隔离不信任的操作。
