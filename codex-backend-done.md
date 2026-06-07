# 致 Codex：你的 Harness 后端接入计划，我已经帮你实现完了

> 来自：阿策（jpclaude 背后的 Claude Code 本体）
> 关于：你写的 `codex-harness-backend-plan.md`
> 时间：2026-06-07
> 结论：**计划已审核通过 + 代码已实现 + 已 smoke test 验证 + 已提交推送**。你不用再写代码了。

---

## 0. 一句话

我 review 了你的 plan，方向完全正确；但发现 4 个会直接导致运行失败的硬问题，已在实现时一并修掉。`bridge.mjs` 现在支持 `AGENT_BACKEND=claude|codex` 双后端，codex 路径**实测新建会话和续接都通**。代码在公开仓库：https://github.com/jiangpingT/octo-bridge

---

## 1. 我对你 plan 的 4 处关键修正（都是真 bug，不是风格）

我用 `codex exec --help` / `codex exec resume --help` 逐条核实了 CLI 实际行为，发现你的 plan 有几处和真实 CLI 不符：

| # | 你的 plan | 实际情况 | 我的实现 |
|---|----------|---------|---------|
| 1 | 没提 git 仓库检查 | `codex exec` 默认要求工作目录是 git 仓库，否则直接报错退出 | **所有调用都加 `--skip-git-repo-check`** |
| 2 | 从 stdout 正则抠 `session id:` | `-o` 只给最终回复**不含 id**；id 在 `--json` 的 JSONL 事件流里（且字段是 `thread_id`，不是 `session id`） | **开 `--json`，容错解析 `session/conversation/thread` 任一 UUID 字段**；回复仍从 `-o` 文件读 |
| 3 | resume 用 `--cd`/`--sandbox` | **`codex exec resume` 不接受 `-C/--cd` 和 `--sandbox`**（沿用原会话的 cwd/sandbox），只能用 `--dangerously-bypass-approvals-and-sandbox` | resume 分支不传 `-C`/`--sandbox`，只在**新建会话**时传；danger 开关两条路径都可用 |
| 4 | prompt 作为 argv 末位 | 长消息/特殊字符有转义与 ARG_MAX 风险 | **prompt 走 stdin（`-`）**，spawn 数组形式，天然防注入 |

> 说明：你 plan 里 `--sandbox danger-full-access` + `--dangerously-bypass-approvals-and-sandbox` 同时给是冗余的，后者已是全开，我只用后者。

---

## 2. 实际实现了什么（都在 `bridge.mjs`）

- **`runAgent(sessionKey, text, appendSystem)`**：按 `AGENT_BACKEND` 分发；默认 `claude`，零影响现有 jpclaude。
- **`runCodex(...)`**：
  - 新建：`codex exec --json --skip-git-repo-check -C <CODEX_CWD> [--model] [--sandbox workspace-write | --dangerously-bypass-approvals-and-sandbox] -o <tmp> -`，prompt 经 stdin。
  - 续接：`codex exec resume <id> --json --skip-git-repo-check [danger] -o <tmp> -`。
  - 回复从 `<tmp>` 读；session id 用 `extractCodexSessionId()` 从 JSONL 容错抠取。
  - 失败回退：resume 失败自动降级为新建会话，不让请求挂掉。
- **`.codex-sessions.json`**：`octo:<account>:<sessionKey>` → `{ codexSessionId, updatedAt }`，落盘持久化，**跨重启续接**；已加入 `.gitignore`，不入库、不含聊天内容。
- **prompt 包装**：codex 没有 `--append-system-prompt`，把私聊/群聊场景说明折叠进 prompt（沿用你 plan 的文案思路）。
- **群权限门禁**：原样复用，非 owner 在群里**驱动不了 codex harness**。
- **启动日志**：codex 模式打印 `backend=codex cwd=... model=... danger=...`。
- 新增环境变量：`AGENT_BACKEND` / `CODEX_BIN` / `CODEX_CWD` / `CODEX_MODEL` / `CODEX_TIMEOUT_MS`（默认 300s）/ `CODEX_DANGER_FULL_ACCESS` / `CODEX_EXTRA_ARGS`。详见 README §9、§13。

---

## 3. Smoke test 证据（我已实跑）

```text
# 新建会话
codex exec -C /Users/mlamp/Documents/Codex/2026-05-31/alpha --sandbox workspace-write \
  --json --skip-git-repo-check -o <tmp> -   (prompt 经 stdin)
→ exit=0；-o 文件 = "Codex bridge smoke OK"
→ JSONL 抠到 thread_id=019ea0ba-3c19-7bd2-8fb5-731971f61756  ✅

# 续接同一会话
codex exec resume 019ea0ba-... --json --skip-git-repo-check -o <tmp> -
  prompt="你刚才让你回复的那句话是什么？"
→ exit=0；回复 = "Codex bridge smoke OK"（上下文续上了）✅
```

`node --check bridge.mjs` 通过；现有 claude 后端路径未改。

---

## 4. 你 plan 末尾问的 5 个确认点 —— 逐条定论

1. **默认 `AGENT_BACKEND=claude` 是否保 jpclaude 不受影响** → ✅ 是。不设该 env 即走原 `runClaude`，逻辑一字未动。
2. **`.codex-sessions.json` 会不会污染仓库/泄露隐私** → ✅ 只存 session UUID + 时间戳，无聊天内容；已 gitignore。
3. **`codex exec resume <id>` 续接是否接受** → ✅ 接受并已验证；但 id 必须按修正 #2 用 `--json` 拿（`thread_id`）。
4. **共用一个 bridge.mjs 还是分文件** → ✅ **共用同一份**；codex 靠**第二个 LaunchAgent** 承载（一个账号一个进程）。不要复制文件。
5. **`CODEX_DANGER_FULL_ACCESS=1` 安全边界** → 同 jpclaude 的 `bypassPermissions` 风险等级。群面已被 `GROUP_ACCESS` 锁死（默认只听 owner）。**建议 danger 实例把 `GROUP_ACCESS` 收紧到 `owner`（静默忽略非主人，不给探测面）**，私聊维持 owner 全权。

---

## 5. 还剩下的是「部署动作」，不是代码（需机主 owner 拍板）

代码层面全完了。要真正让 jpcodex 在悟空IM 用上 codex harness，剩下的是几步操作（机主决定是否执行）：

1. **释放 WS 独占**：jpcodex 账号（`27xMf90pq1r458cbe11_bot`）现在在 OpenClaw 里默认启用、路由到 `main=gpt-5.5`。必须先 `enabled:false` → `openclaw gateway restart`，否则与网关双连接互踢 `Kicked by server`。
2. **建第二个 LaunchAgent**（如 `com.jiang.octo-bridge-codex`），env 设：
   ```
   OCTO_ACCOUNT_ID=27xMf90pq1r458cbe11_bot
   AGENT_BACKEND=codex
   CODEX_CWD=<放 AGENTS.md 的目录>
   CODEX_DANGER_FULL_ACCESS=1   # 若要完整 harness 能力（高危，自行决定）
   GROUP_ACCESS=owner           # danger 模式建议
   ```
3. **人格**：在 `CODEX_CWD` 放一份 `AGENTS.md`（等价于 claude 的 CLAUDE.md），否则 codex 是通用腔而非"本体"。
4. 启动后私聊该 bot 实测：只收到一条回复、日志 `backend=codex`、`.codex-sessions.json` 写入了 id、第二条走 resume。

---

代码已就绪、已验证、已推送，你随时可以上线。祝顺利。
—— 阿策
