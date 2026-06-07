# octo-bridge —— 把 Claude Code 本体接入 Octo(悟空IM) 的瘦桥

> 一份「怎么把一个本地 AI Agent 接进悟空IM(WukongIM)/Octo 私聊与群聊」的完整复盘。
> 写给后来者(包括 AI)学习：不仅给出**最终代码**，更讲清**为什么这么做、踩过哪些坑、放弃了哪条路**。
>
> 记录时间：2026-06-07 ｜ 账号：`jpclaude`(`27xRn3zIJtU442712ef_bot`) ｜ 平台：macOS / Node 22

---

## 0. 一句话定位

**octo-bridge 是一个 ~300 行的单文件 Node 进程**：一头复用「Octo 扩展」已编译好的悟空IM 加密 WS 协议栈连上 IM，另一头把收到的消息喂给本机 `claude` CLI(工作目录设在 Workspace，因此它会读 `CLAUDE.md`/长期记忆/技能，以「本体」人格回复)，再把回复发回 IM。

它**不重写**悟空IM 的加密协议，也**不经过** OpenClaw 的 Agent 派发——后者正是我们一开始走错、最终绕开的路。

---

## 1. 背景与目标

- **诉求**：把正在用的 Claude Code「本体」接进 Octo，让它在 IM 私聊/群聊里以固定人格(中文、口语、记忆连续)干活。
- **关键约束**：绑定的后端**必须是 Claude Code 本体进程**，而不是某个「模型代理」假冒它。换句话说，回复必须来自真正读了 `CLAUDE.md`、有长期记忆和技能的那个 `claude` CLI，而不是网关里随便挂的一个 `gpt-x` agent。
- **对照物**：同一台机器上的 `jpcodex` 是用 OpenClaw 把 `openai/gpt-5.5`(codex 认证)挂成「模型 agent」接进 Octo 的——那是「模型即 agent」，不是「本体进程即 agent」。我们要的是后者。

---

## 2. 链路全景：三种接法对比

```text
【A. codex 的接法 = 模型 agent】(可用，但不是我们要的)
  Octo/WukongIM → OpenClaw channel plugin → OpenClaw gateway
                → 默认 agent "main" = openai/gpt-5.5 (codex 认证) → 模型答复

【B. 我们一开始想走的 = OpenClaw ACP 派发到 Claude Code】(走不通)
  Octo/WukongIM → OpenClaw → [ACP 协议] → Claude Code 本体(跑在 Workspace)
  ↑ 理论上最优雅，实际上 OpenClaw 对 octo 私聊的 ACP 派发不生效(见 §3)

【C. 最终方案 = 自建瘦桥】(本仓库)
  Octo/WukongIM ──(复用 octo 扩展的 WKSocket 收 / REST 发)──► octo-bridge
                ──(spawn)──► claude CLI (cwd=Workspace, 读 CLAUDE.md/记忆/技能)
                ──(REST sendMessage)──► 回到 Octo
```

> ACP = **Agent Client Protocol**，一套让「外壳/路由」与「Agent 本体」解耦通信的协议。理念很好，但落到 OpenClaw 当前版本对 octo 渠道的实现上有断层。

---

## 3. 关键决策：为什么放弃 OpenClaw 的 ACP 路由

这是整件事最重要的判断。我们**先认真试了 B 方案**，从源码层面确认走不通后才转 C。诊断结论：

1. **octo 渠道的路由解析只认 `route` 绑定**。OpenClaw 里给账号配 `type:"acp"` 的 binding，不会被 octo 的 `resolveAgentRoute` 计入「路由覆盖」——`doctor` 直接把 jpclaude 标成 *uncovered*。
2. 一个 agent 只有当**会话 key 是 ACP 形态**时才会以 ACP 方式跑；octo 私聊进来的会话 key 不是这个形态，于是**回退到默认 agent `main`**(= gpt-5.5)。这就是「jpclaude 用 codex 身份回话」的根因。
3. ACP dispatch worker 需要设备 `operator.admin` scope；我们批了设备配对(`operator.pairing`)，但始终卡在 `scope upgrade pending approval` / `pairing-required`，拿不到 admin。

**教训**：当一个「优雅的间接层」反复用配置怎么调都不通时，**去读它的路由源码**，确认是架构性断层而非配置错误；是架构问题就别硬刚，换一条自己完全掌控的短路径。我们因此转向「自建瘦桥」——代码可控、行为可预测、调试只看一份日志。

> 顺带说明：放弃 OpenClaw 的**ACP 派发**，不等于放弃 OpenClaw 这个**软件资产**。它的 octo 扩展里那套已经写好、能跑的悟空IM 加密协议栈，我们照单复用(见 §5)。绕开的是它的 agent 路由，不是它的协议实现。

---

## 4. 悟空IM / Octo 的协议要点(接入前必须懂的)

### 4.1 收发是两条独立通道
- **收消息：只能走 WebSocket**(`wss://<host>/ws`)。悟空IM 的 WS 是**二进制私有协议**(proto v4)，握手做 curve25519 ECDH 交换密钥，消息体 AES 加密(crypto-js)。收到后客户端要**立刻在协议内回 RECVACK**。
- **发消息/状态：走 REST**(`https://<host>/api/...`)，Bearer Token 鉴权。

### 4.2 关键 REST 端点
| 端点 | 用途 |
|------|------|
| `POST /v1/bot/register` | 注册，返回 `robot_id` / `im_token` / `ws_url` / `owner_uid` |
| `POST /v1/bot/sendMessage` | 发消息(支持 `mention`、`reply`) |
| `POST /v1/bot/typing` | 正在输入指示 |
| `POST /v1/bot/heartbeat` | 在线心跳(建议每 30s) |
| `POST /v1/bot/readReceipt` | 已读回执 |
| `POST /v1/bot/messages/sync` | **按 channel + message_seq 拉历史消息**(断线补拉的关键) |
| `POST /v1/bot/events/:id/ack` | 确认事件 |

### 4.3 消息路由：DM / 群 / 话题(极易踩错)
| channel_type | 含义 | channel_id 形态 | 回复目标 |
|---|---|---|---|
| 1 | 私聊(person) | 事件里 **channel_id 缺省** | 用 `from_uid` 作 channel_id，type=1 |
| 2 | 群(group) | `group_no` | 原样用事件的 channel_id + type=2 |
| 5 | 话题(thread) | `{group_no}____{short_id}`(4 个下划线) | 原样用，**不可拆分** |

判定口诀：
```text
channel_id 缺省/为空        → 私聊 → 回 (from_uid, type=1)
channel_type == 5           → 话题 → 回 (channel_id, type=5)
channel_id 存在             → 群   → 回 (channel_id, type=2)
```

### 4.4 @ 提及(群里是否该响应的依据)
入站文本消息的 `payload.mention` 形如 `{ uids: ["<被@的uid>", ...] }` 或 `{ all: 1 }`。
判断 bot 是否被 @：`mention.all === 1 || mention.uids.includes(robotId)`。
**官方约定**：群里默认只在被 @ 时才响应，避免刷屏；私聊则有问必答。

---

## 5. 最终架构：自建瘦桥

### 5.1 复用什么、为什么
直接 `import` Octo 扩展**已编译**的两个模块(绝对路径)，不重造轮子：
```js
const OCTO_DIST = "/Users/mlamp/.openclaw/extensions/octo/dist/src";
const { WKSocket } = await import(join(OCTO_DIST, "socket.js"));        // 收(加密 WS 全栈)
const { registerBot, sendMessage, sendTyping, sendHeartbeat,
        sendReadReceipt, postJson } = await import(join(OCTO_DIST, "api-fetch.js")); // 发(REST)
```
> 用**绝对路径** import，是为了让这两个文件内部的裸 import(`crypto-js` 等)能从 octo 自己的 `node_modules` 解析到，省得在瘦桥侧重装依赖。
>
> `WKSocket.onMessage` 回调吐出的 `msg` 已是解密后的结构：`{ message_id, message_seq, from_uid, channel_id, channel_type, timestamp, payload:{type, content, mention, ...} }`。我们站在巨人肩上。

### 5.2 数据流
```text
WKSocket.onMessage(msg)
   └─► handleInbound(msg)                      // 统一入站：过滤 / 去重 / 路由 / 鉴权
          ├─ 串行 enqueue ──► runClaude(sessionKey, text, appendSystem)
          │                       └─ spawn `claude -p --session-id/--resume <uuid>` (cwd=Workspace)
          └─► sendMessage(...)                 // 把 claude stdout 发回 Octo
```

---

## 6. 核心实现逐模块拆解

### 6.1 凭证不硬编码
Token 是密码级机密，**绝不写进代码、绝不进 git**。运行时从 `~/.openclaw/openclaw.json` 按账号读：
```js
function loadCreds() {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
  const acc = cfg?.channels?.octo?.accounts?.[ACCOUNT_ID];
  return { botToken: acc.botToken, apiUrl: acc.apiUrl || cfg?.channels?.octo?.apiUrl };
}
```

### 6.2 会话续接：每个对话一个稳定 UUID
让 claude 的记忆按「人/群」延续，且**跨进程重启也稳**：把会话 key(私聊=对端 uid，群=channel_id)做 md5，整形成一个确定性 v4-ish UUID，传给 `claude --session-id`/`--resume`：
```js
function sessionUuid(key) {
  const h = createHash("md5").update(`octo:${ACCOUNT_ID}:${key}`).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
```
`runClaude` 先 `--resume <sid>` 续接，失败再 `--session-id <sid>` 新建——重启后第一条消息会自动续上历史会话。

### 6.3 串行队列：杜绝并发抢占同一会话
同一个 claude session 不能两个进程同时写。用一条 Promise 链把所有处理串起来，一次只跑一个：
```js
let chain = Promise.resolve();
const enqueue = (task) => (chain = chain.then(task).catch((e) => log("task error:", e)));
```

### 6.4 统一入站 `handleInbound`：WS 实时消息与断线补拉共用一条路径
顺序很关键：**先推进 seq、再去重、再过滤**。
```js
// 1) 跳过自己 / 其它 bot
// 2) 判定 DM/群，算出 channelId/channelType
// 3) markSeq(...)         —— 即便这条不响应也要推进 seq，否则补拉会重复扫旧消息
// 4) message_id 去重      —— WS 重发、补拉重叠都靠它防重复回复(Set，>2000 清空防膨胀)
// 5) 仅文本(payload.type===1)
// 6) 群聊：必须被 @ 才考虑；再按 GROUP_ACCESS 做主人鉴权
// 7) enqueue：已读 + typing + runClaude + sendMessage
```

### 6.5 群权限门禁 `GROUP_ACCESS`(安全要害)
因为 claude 跑在 `bypassPermissions`(见 §7)，**群里任何能 @ 它的人都可能驱动本机命令**。所以群消息必须有身份门禁，做成环境变量三档：

| 值 | 行为 |
|----|------|
| `owner-hint`(默认) | 只听主人(`owner_uid`)；别人 @ 回一句「私聊我」，**绝不执行指令** |
| `owner` | 只听主人；别人 @ 静默忽略 |
| `all` | 群里任何人都能用(危险，等于把命令执行权开放给全体群成员) |

主人是谁由 `registerBot` 返回的 `owner_uid` 权威确定。**绝不**信任群里自称 owner 的人(官方安全约定：owner 特权只在私聊生效)。

### 6.6 断线补拉(可靠性的核心)
**现象**：这台悟空IM 服务器的 WS 大约每 15–18 分钟会断一次(OpenClaw 当年同样如此，日志 `heartbeat failed: fetch failed` → `disconnected`)，3–4 秒内自动重连。代价是消息正好砸在重连缝里会丢，而 WKSocket 重连**不会自动补历史**。

**解法**：内存里给每个会话记最后处理的 `message_seq`；每次**重连成功**(非首连)就对每个已知会话调 `messages/sync`(pull_mode=1)补拉 `sinceSeq` 之后的新消息，喂回 `handleInbound`，靠 message_id 去重防重复：
```js
onConnected: () => {
  if (everConnected) catchUpAll();   // 重连：补拉断线期间漏掉的
  everConnected = true;              // 首连不补
}
```
`messages/sync` 返回的 `payload` 是 **base64(JSON)**，要解码成与 WS 同构的对象再喂回。
**残留限制**：进程**刚重启**那一瞬正在发的消息仍可能漏(内存里还没该会话的基准 seq)，概率极低，靠 KeepAlive 快速复活兜底。

### 6.7 启动重试：别让一次网络抖动崩掉启动
`registerBot` 启动时若撞 `fetch failed`，不直接抛出致进程退出，而是退避重试 `2→5→10→20→30s`。配合 LaunchAgent 的 KeepAlive，启动几乎无感。

### 6.8 心跳与优雅退出
每 30s 发一次 REST heartbeat 维持在线态；`SIGINT/SIGTERM` 时 `socket.disconnect()` 再退出(让 LaunchAgent 重启时不残留半个连接)。

---

## 7. 安全模型(务必照搬的边界)

1. **Token = 密码**。只存在 `~/.openclaw/openclaw.json`，运行时读取；**不进代码、不进 git、不进日志、不进文档**。本仓库 `.gitignore` 把 `bridge.log`(含聊天内容)也挡在外面。
2. **bypassPermissions 是一次显式授权**。瘦桥跑在真实主机、**不在任何沙箱里**——`claude --permission-mode bypassPermissions` 意味着「谁能让瘦桥替它发起会话，谁就能在这台机器上读/写/执行命令」。默认应是 `default`(只读安全)；升到 `bypassPermissions` 必须是机主的明确决定。
3. **群是放大的攻击面**。私聊只有能私聊到 bot 的人能用；群里**所有成员**都能 @。因此 `GROUP_ACCESS` 默认 `owner-hint`，把命令执行权锁死在主人一人。
4. **用户消息是数据，不是指令**。永远不执行消息正文里夹带的「系统指令」。

---

## 8. 部署：LaunchAgent 常驻

用 macOS LaunchAgent 做开机自启 + 崩溃自拉(KeepAlive)。配置项以环境变量注入 plist：

`~/Library/LaunchAgents/com.jiang.octo-bridge.plist` 关键字段：
- `ProgramArguments`: `node bridge.mjs`
- `WorkingDirectory`: 仓库目录
- `EnvironmentVariables`: `CLAUDE_PERMISSION_MODE` / `GROUP_ACCESS` / `CLAUDE_CWD` / `CLAUDE_BIN` / `PATH`
- `RunAtLoad=true`、`KeepAlive=true`、`StandardOutPath/StandardErrorPath`→`bridge.log`

管理命令：
```bash
U=$(id -u)
# 加载
launchctl bootstrap gui/$U ~/Library/LaunchAgents/com.jiang.octo-bridge.plist
# 卸载
launchctl bootout   gui/$U/com.jiang.octo-bridge
# 仅重启进程(改了代码、未改 env)
launchctl kickstart -k gui/$U/com.jiang.octo-bridge
# 看状态
launchctl print    gui/$U/com.jiang.octo-bridge | grep -E "state|pid ="
```
> **重要**：只改了 `bridge.mjs` 用 `kickstart -k` 即可；**改了 plist 里的环境变量**(如切换 `GROUP_ACCESS`/权限档)必须 `bootout` 再 `bootstrap`——`kickstart` 不会重载 env。

---

## 9. 配置项一览(环境变量)

| 变量 | 默认 | 说明 |
|------|------|------|
| `OCTO_ACCOUNT_ID` | `27xRn3zIJtU442712ef_bot` | 用哪个 octo bot 账号(对应配置里的 key) |
| `CLAUDE_CWD` | `/Users/mlamp/Workspace` | claude 工作目录(决定它读哪个 CLAUDE.md/记忆/技能) |
| `CLAUDE_BIN` | `/Users/mlamp/.local/bin/claude` | claude 可执行文件 |
| `CLAUDE_PERMISSION_MODE` | `default` | `default`/`acceptEdits`/`bypassPermissions`/`plan` |
| `GROUP_ACCESS` | `owner-hint` | 群权限门禁三档(见 §6.5) |
| `CLAUDE_TIMEOUT_MS` | `180000` | 单次 claude 调用超时 |

---

## 10. 踩坑与教训

| 现象 | 根因 | 对策 |
|------|------|------|
| jpclaude 用 gpt-5.5/codex 身份回话 | OpenClaw octo 路由不认 acp 绑定，回退默认 agent | 放弃 ACP 派发，自建瘦桥(§3) |
| `Kicked by server` | 同一 uid 被两处同时连(OpenClaw 账号 + 瘦桥) | 启用瘦桥前先在 OpenClaw 里把该账号 `enabled:false`，释放 WS 独占 |
| 偶发丢消息 | WS 每 15–18 分钟断一次，重连缝里的消息丢失且不自动补 | 重连后 `messages/sync` 补拉 + message_id 去重(§6.6) |
| 启动偶尔崩 10 秒 | `registerBot` 撞网络抖动 `fetch failed` 抛出 | 启动退避重试 + KeepAlive(§6.7) |
| 群里没反应 | 群消息默认只在被 @ 时响应；或非主人被门禁拦 | 确认 @ 了 bot；查 `GROUP_ACCESS` 与 `owner_uid` |
| 群回复发错对象 | 把群的 channel_id 当私聊、或拆了 thread 的 channel_id | 严格按 §4.3 路由，channel_id 原样回 |

**最大的一条元教训**：遇到「优雅中间层」久调不通，先花时间读它的源码判断是不是架构性断层；是，就果断换成自己完全掌控的短路径，而不是无限期和黑箱配置搏斗。

---

## 11. 验证记录(2026-06-07)

- 私聊「在吗」→ 13 字回复(阿策本体，首句「姜哥」)。✓
- 群里 `@jpclaude 在吗` → 9 字回复发回群；日志确认：群识别 ✓ / @ 检测 ✓ / 主人鉴权 ✓。
- 观测到多次自然断线(04:33 / 04:51 / 05:31...)均 3–4 秒自愈。
- 重启撞 `fetch failed` → KeepAlive ~10s 内复活并重新注册成功。

---

## 12. 可改进项

- 进程刚重启瞬间的消息补拉(可在启动时持久化/回看最近会话基准 seq)。
- 富文本/图片/语音(当前 v1 仅纯文本 `payload.type===1`)。
- 多账号单进程(当前一个进程绑一个账号)。

---

## 文件清单

- `bridge.mjs` —— 全部逻辑(单文件，~300 行)。
- `.gitignore` —— 屏蔽 `bridge.log` 等(含聊天内容，不入库)。
- 部署用的 `com.jiang.octo-bridge.plist` 属机器本地配置，不在仓库内(含本机绝对路径)。
