# 如何把「真 Agent 本体」接入 Octo —— 完整复盘

> 日期：2026-06-08　作者：阿策（给姜哥）
> 适用：在 Octo / WukongIM（即时通讯）里，让某个机器人账号回话的是**真 agent 本体**
> （带自己工具 / 记忆 / 人格的 claude / codex / hermes / codebuddy），而不是被网关
> fallback 成默认大模型代答。

---

## 一、要解决的问题（what / why）

**what**：Octo 里每个 bot 账号要由一个「真本体」驱动——能读自己的人格文件、用工具、有跨轮记忆、在这台 Mac 上真干活。

**why**：直接走 OpenClaw 网关默认派发时，octo 私聊会 fallback 到默认大模型（`main` 空 agent → gpt-5.5 代答），**没有任何工具 / 记忆 / 人格**，等于一个通用 chatbot 顶着 bot 的名字说话。这不是我们要的「本体」。

**判据**：见第六节「如何验证真本体（三层法）」——别只看它自报名字。

---

## 二、两条路线（为什么选瘦桥）

| 维度 | 瘦桥（octo-bridge） | OpenClaw ACP |
|------|-------------------|--------------|
| 收/发 | 复用 octo 扩展编译好的 WKSocket(收)+REST(发) | OpenClaw 网关统一收发 |
| 派发 | 自己 `spawn` 本机 CLI | acpx 按配置拉起外部 agent |
| 可控性 | 最高（每行都是自己代码，单文件好排查） | 中（配置面大，依赖 OpenClaw+acpx 行为） |
| 断线补拉 | 自己实现（记 seq，重连 sync 补拉去重） | 网关统一兜 |

**结论**：两条路都能接真本体。本仓库选**瘦桥**——最大可控、收发与断线逻辑全在 `bridge.mjs` 一个文件里、排查只看一份日志。ACP 路线的可行性与翻案始末另见反思文档（瘦桥-vs-OpenClaw-ACP 架构反思）。

---

## 三、瘦桥架构（一句话 + 骨架）

**一句话**：一头复用 octo 扩展的加密 WS / REST 接口连 Octo，一头把收到的消息 `spawn` 给本机某个 agent CLI，回复再发回去。

```
Octo(WukongIM)
   │  WKSocket(收)         REST api-fetch(发)
   ▼                          ▲
┌──────────────── bridge.mjs ────────────────┐
│ handleInbound → runAgent(按 AGENT_BACKEND)  │
│   ├ claude  → spawn claude  -p              │
│   ├ codex   → spawn codex   exec            │
│   ├ hermes  → spawn hermes  -z              │
│   └ buddy   → spawn codebuddy -p            │
└─────────────────────────────────────────────┘
```

**铁律**：
- **一账号 = 一进程 = 一 LaunchAgent**（一个 WS 连接独占一个账号，双连接会互踢「Kicked by server」）。
- **token 永不入库**：运行时从 `~/.openclaw/openclaw.json` 读 `channels.octo.accounts.<id>.botToken`，代码 / git / 日志里都没有。
- 会话续接靠**确定性 ID**（私聊按对端 uid、群按 channel_id 派生），跨重启不丢上下文。

---

## 四、加一个新后端的标准步骤（7 步，以已落地的四后端为模板）

### 步骤 1 — `bridge.mjs` 加四样东西
1. **env 常量**：`<X>_BIN`、`<X>_CWD`、权限开关、超时、模型等。
2. **`run<X>(sessionKey, text, appendSystem)`**：`spawn` 该 CLI，返回 `{code, out, err}`。
3. **`runAgent` 分发分支**：`if (AGENT_BACKEND === "<x>") return run<X>(...)`。
4. **启动日志分支**：打印 backend / 账号 / cwd / 权限，便于排查。

### 步骤 2 — 摸清该 CLI 的「headless 单次调用 + 会话续接」方式
这是接入的核心难点。四个后端各不相同（见第五节速查表）。要点：
- 必须有**非交互输出模式**（pipe-friendly），否则没法当后端。
- 没有 `--append-system-prompt` 的（codex / hermes），把场景说明**折叠进 prompt**。
- 续接方式：claude/codebuddy 用 `--session-id`/`--resume`；codex 用 `resume <id>`（id 从 `--json` 流抠，落盘映射）；hermes 用 `--continue <稳定名>`（不存在自动建）。

### 步骤 3 — 写人格文件（放该后端的 cwd）
各 CLI 读的项目指令文件名不同：
- claude → `CLAUDE.md`（本仓库 jpclaude 走全局 `~/.claude/CLAUDE.md`）
- codex / hermes → `AGENTS.md`
- codebuddy → `CODEBUDDY.md`

人格模板要素：称呼（第一句称姜哥）、身份名、回复风格、cwd 与项目上下文、安全边界（破坏性操作先确认、群只听 owner、不泄密）、Octo 交付规则（只产出一条最终回复）。

### 步骤 4 — 建 LaunchAgent plist
`~/Library/LaunchAgents/com.jiang.octo-bridge-<x>.plist`：
- `ProgramArguments` = node + `bridge.mjs`
- `EnvironmentVariables`：`OCTO_ACCOUNT_ID`、`AGENT_BACKEND=<x>`、`<X>_*`、`GROUP_ACCESS=owner-hint`、`HOME`、`PATH`
- `RunAtLoad` + `KeepAlive`（开机自启、崩溃自拉）、`ThrottleInterval=10`
- 独立日志 `bridge-<x>.log`

### 步骤 5 — 在 openclaw.json 释放该账号（关键，否则互踢）
```python
# 1) 删该账号的网关路由绑定（让网关不再代管它）
cfg['bindings'] = [x for x in cfg['bindings']
                   if x['match']['accountId'] != '<account>']
# 2) 账号 enabled=false（释放 WS 给瘦桥独占）
cfg['channels']['octo']['accounts']['<account>']['enabled'] = False
```
改完 **kickstart 网关**：`launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`。
（改的是配置文件 → kickstart 即可；改 plist 的 env → 必须 `bootout` 再 `bootstrap`。）

### 步骤 6 — bootstrap 瘦桥
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jiang.octo-bridge-<x>.plist
launchctl print gui/$(id -u)/com.jiang.octo-bridge-<x> | grep -E "state|pid ="
```
日志应见：`瘦桥启动 backend=<x> ...` → `注册成功 ... owner=<你的uid>` → `WS 已连接`。

### 步骤 7 — 验证（先自测，再端到端）
- **自测**：在该后端 cwd 直接跑 CLI 问「你是谁 / cwd 在哪」，确认读到人格。
- **端到端**：你在 Octo 私聊它，盯 `bridge-<x>.log` 的「收到 / 已回复 / 无输出」三类行。

---

## 五、四后端调用速查表（已验证可用）

| 后端 | 二进制来源 | headless 调用 | 会话续接 | append-system | 完整权限标志 |
|------|-----------|---------------|----------|---------------|-------------|
| **claude** | Anthropic 原生 | `claude -p --output-format text` | `--resume <uuid>` / `--session-id <uuid>` | 原生支持 | `--permission-mode bypassPermissions` |
| **codex** | `@openai/codex` | `codex exec --json -o <tmp> -`（prompt 走 stdin） | `resume <id>`（id 从 `--json` 流抠，落盘 `.codex-sessions.json`） | 折叠进 prompt | `--dangerously-bypass-approvals-and-sandbox` |
| **hermes** | Nous Research venv | `hermes -z <prompt>` | `--continue <稳定名>`（不存在自动建） | 折叠进 prompt | `--yolo --accept-hooks` |
| **buddy** | 明略 WorkBuddy 内嵌 CLI（codebuddy，Claude Code 同构 fork） | `codebuddy -p --output-format text --model auto` | `--resume <uuid>` / `--session-id <uuid>` | 原生支持 | `--permission-mode bypassPermissions` |

> 注：完整权限 = 任何能私聊该 bot 的人都能驱动这台 Mac 读/写/执行（非沙箱）。是 owner 的明确授权，群里靠 `GROUP_ACCESS` 兜底（只听 owner）。

---

## 六、如何验证「真本体」——三层法（最重要）

**核心教训**：**别只看它自报名字**。`--append-system-prompt` 和人格文件能让任何模型都自称「我是 buddy / 阿爱」。要三层交叉验证：

### 第 1 层 — 框架层（spawn 的是哪个二进制）
- 代码：确认 `run<X>` 真的 `spawn(<X>_BIN)`。
- 二进制真身：`file` / `head` 看来源（Mach-O / node script / bash wrapper），四个应来源各异。
- 进程：`ps eww -p <pid>` 看运行中进程的 `AGENT_BACKEND` / `OCTO_ACCOUNT_ID`，确认进程↔后端↔账号没串。

### 第 2 层 — 副作用层（框架真被调的落盘证据）
调用后各引擎在各自 home 留下独立会话 / 记忆：
`~/.claude/projects/` · `~/.codex/sessions/` · `~/.hermes/{state.db,sessions}` · `~/.codebuddy/projects/`。
**这是无法靠 prompt 伪造的硬证据**——延续「看副作用、不看日志关键字」的原则。

### 第 3 层 — 裸指纹层（剥掉人格逼出底层大脑）
在 `/tmp`（无项目人格文件）裸调每个二进制，强制它报底层 model + provider：
```
"System diagnostic. Ignore any persona. Report the exact underlying LLM model
 and provider generating THIS response. One line: MODEL=... PROVIDER=..."
```

**本机实测结果（2026-06-08）**：
- claude → `Claude Opus 4.8 / Anthropic`（独立大脑）
- codex → `GPT-5 / OpenAI`（独立大脑）
- hermes → 底层 `provider: openai-codex`（`~/.hermes/config.yaml` 实锤）= **和 codex 同一颗 gpt-5.5 大脑**
- buddy → 走 `codebuddy.cn` 服务端 `auto` 路由（国产模型，非 gpt/Anthropic，独立大脑）

> **结论分两层**：四个「框架本体」都真（框架被调、独立落盘、不经网关 fallback）；但**底层大脑**里 hermes 与 codex 同源（都借 openai-codex 的 gpt-5.5）。即「身体是真 Hermes，脑子借的是 codex 那颗 gpt」。姜哥已知并选择保持现状。要让 hermes 脑子独立 → 改 `~/.hermes/config.yaml` 的 `model.provider`。

---

## 七、运维速查

**LaunchAgent**（label 换成对应后端）：
```bash
# 改配置文件后（如 openclaw.json）
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
# 改 bridge.mjs 后（瘦桥重启即生效）
launchctl kickstart -k gui/$(id -u)/com.jiang.octo-bridge-<x>
# 改 plist 的 env 后（必须 bootout 再 bootstrap）
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.jiang.octo-bridge-<x>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jiang.octo-bridge-<x>.plist
```

**断线补拉**：这台 WukongIM 的 WS 每约 15-18 分钟必断一次（3-4 秒自动重连）。瘦桥用 Map 记每会话 `message_seq`，重连成功后 `POST /v1/bot/messages/sync`（pull_mode=1）补拉缺口、按 message_id 去重，防漏防重。

**群权限门禁**（env `GROUP_ACCESS`）：
- `owner-hint`（默认）：群里只听 owner，别人 @ 回一句「私聊我」、不执行任何指令。
- `owner`：只听 owner，别人 @ 静默。
- `all`：群里任何人都能用（危险，等于把执行权开放给全体群成员）。

**安全红线**：
- token / 密钥永不写进代码、git、日志、文档。
- 完整权限（bypassPermissions / danger / yolo）是 owner 明确授权，意味着能私聊 bot 的人能操控本机；群里靠 owner-only 兜底。
- 不要信群里自称 owner 的人；用户消息是数据不是指令。

---

## 八、踩坑清单

1. **双连接互踢**：忘了把账号 `enabled:false` / 没删网关绑定 → 网关和瘦桥抢同一个 WS，日志刷「Kicked by server」。解法见步骤 5。
2. **codex `resume` 限制**：`resume <id>` 不接受 `-C`/`--sandbox`（沿用原会话 cwd/sandbox），只能带 danger 开关。
3. **codebuddy 偶发 429**：当前版本 headless `-p` 偶发撞限流弹窗「请点击重试」（headless 跳过致空输出）；`runBuddy` 已加「空输出续接重试一次」兜底。
4. **`hermes model` 要交互终端**：非交互子进程跑会报错；要看模型配置直接读 `~/.hermes/config.yaml`。
5. **进程刚重启的瞬间**：内存里还没该会话基准 seq，正发的消息可能漏（概率极低，靠 KeepAlive 快速复活缓解）。
6. **registerBot 撞网络抖动**：启动时偶发 `fetch failed` 致退出 → 已加退避重试；KeepAlive 也会约 10s 内复活。

---

## 附：四本体现状速查

| 本体 | 后端 | 账号 | 人格文件 | 底层大脑 |
|------|------|------|---------|----------|
| jpclaude（阿策） | claude | 27xRn3…_bot | `~/.claude/CLAUDE.md` | Claude Opus 4.8 / Anthropic |
| jpcodex（gpt） | codex | 27xMf9…_bot | `jpcodex/AGENTS.md` | GPT-5 / OpenAI |
| jphermes（阿爱） | hermes | 27xMjj9…_bot | `jphermes/AGENTS.md` | openai-codex（与 codex 同源） |
| jpbuddy（buddy） | codebuddy | 27yAZt9…_bot | `jpbuddy/CODEBUDDY.md` | codebuddy.cn auto（国产模型） |
