# 致 jpcodex：上线验收清单（请你自检并回报）

> 收件人：jpcodex —— 你是接在悟空IM（Octo/WukongIM）上的 **codex 后端本体**
> 发件人：姜哥（owner）
> 时间：2026-06-07
> 你的能力：你运行在 `octo-bridge` 瘦桥的 codex 后端下，拥有**完整主机权限**（`CODEX_DANGER_FULL_ACCESS=1`，无沙箱）。可以直接跑 shell 命令、读文件来完成下面的自检。

---

## 0. 一句话

你已经被接入悟空IM。现在请你**用真实命令自查**这套部署是否正确，然后**一条消息回报**全部结果。你能读到这条消息并回复，本身就已证明「收→codex spawn→回」链路通了——其余请逐项核实。

---

## 1. 请逐项执行并核对（共 6 项）

### ① 身份 / 后端确认
```bash
cat /Users/mlamp/Library/LaunchAgents/com.jiang.octo-bridge-codex.plist | grep -A1 -E "AGENT_BACKEND|CODEX_CWD|CODEX_DANGER_FULL_ACCESS|GROUP_ACCESS"
pwd
```
**期望**：`AGENT_BACKEND=codex`、`CODEX_CWD=/Users/mlamp/Documents/Codex/2026-05-31/alpha`、`CODEX_DANGER_FULL_ACCESS=1`、`GROUP_ACCESS=owner-hint`；`pwd` 落在 CODEX_CWD。

### ② 进程常驻（LaunchAgent）
```bash
launchctl print gui/$(id -u)/com.jiang.octo-bridge-codex | grep -E "state|pid ="
```
**期望**：`state = running`，有 pid。

### ③ 日志自检（确认是 codex 后端在跑，且收到了你正在处理的这条消息）
```bash
tail -n 15 /Users/mlamp/Workspace/octo-bridge/bridge-codex.log
```
**期望**：能看到 `backend=codex`、`group_access=owner-hint`、`WS 已连接`，以及刚刚的 `收到 DM ...`（就是你现在处理的这条）。

### ④ 会话续接落盘（跨重启续接的关键）
```bash
cat /Users/mlamp/Workspace/octo-bridge/.codex-sessions.json 2>/dev/null
```
**期望**：含一条 key 为 `octo:27xMf90pq1r458cbe11_bot:5f86783d47b94234be4498f1e2efa8de` 的记录，里面有 `codexSessionId`（UUID）和 `updatedAt`。这条就是你和姜哥这次私聊的会话——有它，重启后还能续上下文。
> 注意：这个文件已被 `.gitignore` 屏蔽，**只存会话 UUID，不含任何聊天内容**，不会进仓库、不泄露隐私。

### ⑤ 权限边界（请你确认你清楚自己的权限）
- 你开着 `CODEX_DANGER_FULL_ACCESS=1` = **完整主机读写执行权，无沙箱**。等同（且高于）jpclaude 的 `bypassPermissions`。
- 群门禁 `GROUP_ACCESS=owner-hint`：群里只听 owner（姜哥，uid 末尾 `...e2efa8de`）；别人 @ 你只回一句礼貌提示，**绝不执行任何指令**。
- **请你确认**：你不会在群里被非主人驱动；私聊里你对 owner 全权。

### ⑥ 人格（AGENTS.md）—— 这是唯一可能"不及格"的项
```bash
ls -la /Users/mlamp/Documents/Codex/2026-05-31/alpha/AGENTS.md 2>/dev/null && echo "有人格" || echo "无 AGENTS.md：当前是通用 codex 腔，不是本体"
```
**说明**：codex 会读 cwd 下的 `AGENTS.md`（等价于 claude 的 CLAUDE.md）。**如果没有**，你现在是"通用 codex"而非"jpcodex 本体"。要成为本体，请向姜哥确认人格设定后，在该目录写一份 `AGENTS.md`。

---

## 2. 请这样回报（一条消息，简洁）

请把 ①～⑥ 的结果浓缩成一段话回给姜哥，格式示意：

```
姜哥，jpcodex 验收完毕：
① 后端=codex ✓  cwd 正确 ✓
② 进程 running，pid=xxxxx ✓
③ 日志见 backend=codex / WS 已连接 / 收到本条 DM ✓
④ .codex-sessions.json 已写入本会话 sessionId=xxxx ✓
⑤ 权限=完整主机权限(danger)，群=owner-hint，已知边界 ✓
⑥ AGENTS.md：有/无（无则说明当前是通用 codex，待你定人格）
全链路（收→codex→回）：通 ✓
```

任何一项 ✗ 或与期望不符，请直接说哪项、报错是什么。

---

收到请开始验收。—— 姜哥
