// Octo (WukongIM) <-> Claude Code 瘦桥
//
// 一头：复用 octo 扩展编译好的 WKSocket / REST 接口连 Octo（不重写加密 WS 协议）
// 一头：把收到的私聊消息交给本机 claude CLI（cwd=Workspace，读 CLAUDE.md / 记忆 / 技能）
// token 不硬编码——运行时从 ~/.openclaw/openclaw.json 读取。

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const OCTO_DIST = "/Users/mlamp/.openclaw/extensions/octo/dist/src";
const { WKSocket } = await import(join(OCTO_DIST, "socket.js"));
const { registerBot, sendMessage, sendTyping, sendHeartbeat, sendReadReceipt, postJson } =
  await import(join(OCTO_DIST, "api-fetch.js"));

// ---- 配置 ----
const ACCOUNT_ID = process.env.OCTO_ACCOUNT_ID || "27xRn3zIJtU442712ef_bot";
const WORKSPACE = process.env.CLAUDE_CWD || "/Users/mlamp/Workspace";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/Users/mlamp/.local/bin/claude";
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "default";
// 群聊权限：
//   owner-hint（默认）— 只听主人；别人 @ 时回一句礼貌提示，不执行任何指令
//   owner          — 只听主人；别人 @ 时静默忽略（连提示都不发）
//   all            — 群里任何人 @ 都能使唤（危险：等于把命令执行权开放给全体群成员）
const GROUP_ACCESS = process.env.GROUP_ACCESS || "owner-hint";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 180000);

// ---- 后端选择 ----
//   claude（默认）— spawn 本机 claude CLI（cwd=Workspace，本体阿策）
//   codex          — spawn 本机 codex CLI（cwd=CODEX_CWD，Codex harness 本体）
const AGENT_BACKEND = process.env.AGENT_BACKEND || "claude";

// ---- Codex 后端配置（仅 AGENT_BACKEND=codex 时使用）----
const CODEX_BIN = process.env.CODEX_BIN || "/opt/homebrew/bin/codex";
const CODEX_CWD = process.env.CODEX_CWD || "/Users/mlamp/Documents/Codex/2026-05-31/alpha";
const CODEX_MODEL = process.env.CODEX_MODEL || "";          // 空 = 用 codex 默认模型
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 300000);
const CODEX_DANGER_FULL_ACCESS = process.env.CODEX_DANGER_FULL_ACCESS === "1";
const CODEX_EXTRA_ARGS = (process.env.CODEX_EXTRA_ARGS || "").trim()
  ? process.env.CODEX_EXTRA_ARGS.trim().split(/\s+/)
  : [];
// codex 会话映射文件：放在桥自己的目录里（已被 .gitignore 屏蔽，不入库）
const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const CODEX_SESSIONS_FILE = join(BRIDGE_DIR, ".codex-sessions.json");

const APPEND_SYSTEM_DM =
  "你正在通过 Octo IM 和姜哥私聊。直接用中文口语化回复，简洁，不要用 markdown 标题或大段列表。";
const APPEND_SYSTEM_GROUP =
  "你正在通过 Octo IM 的群聊里和姜哥对话（群里还有其他人，但只有姜哥能使唤你）。" +
  "回复要更简短聚焦，只答被问到的，别刷屏，别用 markdown 标题或大段列表。";
// 别人在群里 @ 机器人时的固定礼貌回复（不跑 claude、不执行任何指令）
const GROUP_NON_OWNER_REPLY = "你好，群里我只回应我的主人。有事可以私聊我～";

function loadCreds() {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const acc = cfg?.channels?.octo?.accounts?.[ACCOUNT_ID];
  if (!acc?.botToken) throw new Error(`找不到账号 ${ACCOUNT_ID} 的 botToken`);
  const apiUrl = acc.apiUrl || cfg?.channels?.octo?.apiUrl;
  if (!apiUrl) throw new Error("找不到 apiUrl");
  return { botToken: acc.botToken, apiUrl };
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// 会话 key（私聊=对端 uid，群聊=群 channel_id）-> 稳定 UUID（给 claude --session-id 用，做续接）
function sessionUuid(key) {
  const h = createHash("md5").update(`octo:${ACCOUNT_ID}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function runClaude(sessionKey, text, appendSystem) {
  const sid = sessionUuid(sessionKey);
  const base = ["-p", "--output-format", "text", "--permission-mode", PERMISSION_MODE,
    "--append-system-prompt", appendSystem];
  const tryRun = (sessionArgs) =>
    new Promise((resolve) => {
      const args = [...base, ...sessionArgs, text];
      const child = spawn(CLAUDE_BIN, args, {
        cwd: WORKSPACE,
        env: process.env,
      });
      let out = "", err = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, CLAUDE_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out: out.trim(), err: err.trim() });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out: "", err: String(e) });
      });
    });

  // 优先续接（session 由确定性 UUID 持久化在磁盘，跨重启也在）；续接不出内容再新建。
  return (async () => {
    const r = await tryRun(["--resume", sid]);
    if (r.code === 0 && r.out) return r;
    const created = await tryRun(["--session-id", sid]);
    if (created.code === 0 && created.out) return created;
    // 新建撞 "already in use"：session 其实存在（上次超时残留锁/偶发失败），再试一次续接
    if (/already in use/i.test(created.err || "")) {
      return await tryRun(["--resume", sid]);
    }
    return created;
  })();
}

// ---- Codex 后端 ----
// 会话映射：octo:<account>:<sessionKey> -> { codexSessionId, updatedAt }，持久化到磁盘，跨重启续接
function loadCodexSessions() {
  try { return JSON.parse(readFileSync(CODEX_SESSIONS_FILE, "utf8")); }
  catch { return {}; }
}
let codexSessions = loadCodexSessions();
function saveCodexSessions() {
  try { writeFileSync(CODEX_SESSIONS_FILE, JSON.stringify(codexSessions, null, 2)); }
  catch (e) { log("保存 codex 会话映射失败:", e?.message || e); }
}

// 从 codex --json 的 JSONL 事件流里容错地抠出 session id（兼容字段名漂移：session/conversation/thread）
function extractCodexSessionId(jsonl) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const findId = (o) => {
    if (!o || typeof o !== "object") return null;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && /session|conversation|thread/i.test(k) && uuid.test(v)) return v;
      if (v && typeof v === "object") { const r = findId(v); if (r) return r; }
    }
    return null;
  };
  for (const line of String(jsonl).split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { const id = findId(JSON.parse(s)); if (id) return id; } catch {}
  }
  return null;
}

function runCodex(sessionKey, text, appendSystem) {
  const mapKey = `octo:${ACCOUNT_ID}:${sessionKey}`;
  // codex 没有 --append-system-prompt，把场景说明折叠进 prompt
  const prompt = `${appendSystem}\n\n当前用户消息：\n${text}`;
  const modelArgs = CODEX_MODEL ? ["--model", CODEX_MODEL] : [];

  // 一次 codex exec 调用；prompt 走 stdin（避免 argv 转义/长度问题）；回复从 -o 文件读，session id 从 --json 流抠
  const runOnce = (sessionArgs) =>
    new Promise((resolve) => {
      const tmp = join(tmpdir(), `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const args = ["exec", ...sessionArgs, "--json", "--skip-git-repo-check",
        ...modelArgs, ...CODEX_EXTRA_ARGS, "-o", tmp, "-"];
      const child = spawn(CODEX_BIN, args, { cwd: CODEX_CWD, env: process.env });
      let stdout = "", err = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, CODEX_TIMEOUT_MS);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        let out = "";
        try { out = readFileSync(tmp, "utf8").trim(); } catch {}
        try { unlinkSync(tmp); } catch {}
        resolve({ code, out, err: err.trim(), sid: extractCodexSessionId(stdout) });
      });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e), sid: null }); });
      try { child.stdin.write(prompt); child.stdin.end(); } catch {}
    });

  return (async () => {
    const existing = codexSessions[mapKey]?.codexSessionId;
    const dangerFlag = CODEX_DANGER_FULL_ACCESS ? ["--dangerously-bypass-approvals-and-sandbox"] : [];

    // 续接：resume 不接受 -C/--sandbox（沿用原会话的 cwd/sandbox），只能用 danger 开关
    if (existing) {
      const r = await runOnce(["resume", existing, ...dangerFlag]);
      if (r.code === 0 && r.out) {
        if (r.sid) { codexSessions[mapKey] = { codexSessionId: r.sid, updatedAt: new Date().toISOString() }; saveCodexSessions(); }
        return r;
      }
      log(`codex resume 失败(code=${r.code} err=${r.err.slice(0, 160)})，回退新建会话`);
    }

    // 新建：可设 -C / --sandbox
    const sandbox = CODEX_DANGER_FULL_ACCESS
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--sandbox", "workspace-write"];
    const r = await runOnce(["-C", CODEX_CWD, ...sandbox]);
    if (r.code === 0 && r.sid) {
      codexSessions[mapKey] = { codexSessionId: r.sid, updatedAt: new Date().toISOString() };
      saveCodexSessions();
    }
    return r;
  })();
}

// 统一入口：按 AGENT_BACKEND 分发
function runAgent(sessionKey, text, appendSystem) {
  if (AGENT_BACKEND === "codex") return runCodex(sessionKey, text, appendSystem);
  return runClaude(sessionKey, text, appendSystem);
}

async function main() {
  const { botToken, apiUrl } = loadCreds();
  if (AGENT_BACKEND === "codex") {
    log(`瘦桥启动 backend=codex account=${ACCOUNT_ID} api=${apiUrl} codex_cwd=${CODEX_CWD} model=${CODEX_MODEL || "(default)"} danger=${CODEX_DANGER_FULL_ACCESS}`);
  } else {
    log(`瘦桥启动 backend=claude account=${ACCOUNT_ID} api=${apiUrl} cwd=${WORKSPACE} perm=${PERMISSION_MODE}`);
  }

  // 注册带重试：启动时若撞网络抖动（fetch failed）不直接崩，退避重试
  const creds = await (async () => {
    const delays = [2000, 5000, 10000, 20000, 30000];
    for (let i = 0; ; i++) {
      try {
        return await registerBot({
          apiUrl, botToken, agentPlatform: "ClaudeCodeBridge", agentVersion: "0.1.0",
        });
      } catch (e) {
        const wait = delays[Math.min(i, delays.length - 1)];
        log(`注册失败(${i + 1}): ${e?.message || e}，${wait / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  })();
  const robotId = creds.robot_id;
  const ownerUid = creds.owner_uid || creds.ownerUid || "";
  const wsUrl = creds.ws_url || creds.wsUrl ||
    apiUrl.replace(/^http/, "ws").replace(/\/api\/?$/, "/ws");
  log(`注册成功 robot_id=${robotId} owner=${ownerUid || "未知"} ws=${wsUrl} group_access=${GROUP_ACCESS}`);

  // 串行队列：一次只处理一条，避免并发 claude 抢占同一会话
  let chain = Promise.resolve();
  const enqueue = (task) => (chain = chain.then(task).catch((e) => log("task error:", e)));

  // ---- 断线补拉所需状态 ----
  // 每个会话最后处理过的 message_seq（key=`${channelType}:${channelId}`），重连后据此补拉
  const lastSeqByChannel = new Map();
  // 已处理过的 message_id，去重（WS 重发 / 补拉重叠都靠它防重复回复）
  const processedIds = new Set();
  let everConnected = false;          // 首次连接不补拉，重连才补

  const chanKey = (ct, cid) => `${ct}:${cid}`;

  function markSeq(ct, cid, seq) {
    if (!seq) return;
    const k = chanKey(ct, cid);
    const prev = lastSeqByChannel.get(k) || 0;
    if (seq > prev) lastSeqByChannel.set(k, seq);
  }

  // 统一入站处理：WS 实时消息和断线补拉都走这里
  function handleInbound(msg) {
    try {
      if (!msg || msg.from_uid === robotId) return;          // 跳过自己
      if (msg.from_uid?.endsWith?.("_bot")) return;          // 跳过其它 bot

      const isDM = !msg.channel_id || msg.channel_type === 1;
      const channelId = isDM ? msg.from_uid : msg.channel_id;
      const channelType = isDM ? 1 : msg.channel_type;

      // 记录 seq（即便不是文本/不响应，也要推进，避免补拉重复扫旧消息）
      markSeq(channelType, channelId, Number(msg.message_seq) || 0);

      // 去重：同一条消息只处理一次
      const mid = msg.message_id != null ? String(msg.message_id) : "";
      if (mid) {
        if (processedIds.has(mid)) return;
        processedIds.add(mid);
        if (processedIds.size > 2000) processedIds.clear();  // 防无限增长
      }

      if (msg.payload?.type !== 1) return;                   // v1 仅文本
      const text = String(msg.payload.content ?? "").trim();
      if (!text) return;

      // 会话续接 key：私聊按人、群按群（群内多人共享同一会话上下文）
      const sessionKey = isDM ? msg.from_uid : msg.channel_id;
      const appendSystem = isDM ? APPEND_SYSTEM_DM : APPEND_SYSTEM_GROUP;

      if (!isDM) {
        // 群里只在被 @ 时才考虑响应（不刷屏）
        const mention = msg.payload?.mention;
        const mentioned = mention?.all === 1 ||
          (Array.isArray(mention?.uids) && mention.uids.includes(robotId));
        if (!mentioned) return;

        const isOwner = ownerUid && msg.from_uid === ownerUid;
        if (!isOwner && GROUP_ACCESS !== "all") {
          // 非主人 @：按策略静默或回礼貌提示，绝不执行任何指令
          log(`群非主人 @ from=${msg.from_uid} access=${GROUP_ACCESS}（不执行）`);
          if (GROUP_ACCESS === "owner-hint") {
            enqueue(async () => {
              await sendMessage({ apiUrl, botToken, channelId, channelType,
                content: GROUP_NON_OWNER_REPLY }).catch(() => {});
            });
          }
          return;
        }
      }

      log(`收到 ${isDM ? "DM" : "群"} from=${msg.from_uid} ch=${channelId}: ${text.slice(0, 80)}`);

      enqueue(async () => {
        sendReadReceipt({ apiUrl, botToken, channelId, channelType,
          messageIds: msg.message_id ? [msg.message_id] : [] }).catch(() => {});
        sendTyping({ apiUrl, botToken, channelId, channelType }).catch(() => {});
        const r = await runAgent(sessionKey, text, appendSystem);
        let reply = r.out;
        if (!reply) {
          log(`claude 无输出 code=${r.code} err=${r.err.slice(0, 200)}`);
          reply = "（抱歉姜哥，我这边没生成出回复，稍后再试一次）";
        }
        await sendMessage({ apiUrl, botToken, channelId, channelType, content: reply });
        log(`已回复 (${reply.length} 字)`);
      });
    } catch (e) {
      log("handleInbound 异常:", e);
    }
  }

  // 补拉单个会话在 sinceSeq 之后的新消息（重连后调用）
  async function syncChannel(channelType, channelId, sinceSeq) {
    try {
      const res = await postJson(apiUrl, botToken, "/v1/bot/messages/sync", {
        channel_id: channelId,
        channel_type: channelType,
        start_message_seq: sinceSeq,
        end_message_seq: 0,
        limit: 50,
        pull_mode: 1,              // 拉取更新的消息
      });
      const list = Array.isArray(res?.messages) ? res.messages : [];
      let replayed = 0;
      for (const m of list) {
        const seq = Number(m.message_seq) || 0;
        if (seq <= sinceSeq) continue;                       // 只补 sinceSeq 之后的
        // sync 返回的 payload 是 base64(JSON)，解码成与 WS 同构的对象
        let payloadObj = {};
        try {
          const raw = typeof m.payload === "string"
            ? Buffer.from(m.payload, "base64").toString("utf8")
            : JSON.stringify(m.payload ?? {});
          payloadObj = JSON.parse(raw);
        } catch { payloadObj = (typeof m.payload === "object" && m.payload) || {}; }
        handleInbound({
          message_id: m.message_id,
          message_seq: seq,
          from_uid: m.from_uid,
          channel_id: m.channel_id,
          channel_type: m.channel_type,
          timestamp: m.timestamp,
          payload: { type: payloadObj?.type ?? 0, content: payloadObj?.content, ...payloadObj },
        });
        replayed++;
      }
      if (replayed) log(`补拉 ${chanKey(channelType, channelId)} 补回 ${replayed} 条`);
    } catch (e) {
      log(`补拉 ${chanKey(channelType, channelId)} 失败:`, e?.message || e);
    }
  }

  async function catchUpAll() {
    if (lastSeqByChannel.size === 0) return;
    log(`重连补拉：扫描 ${lastSeqByChannel.size} 个会话`);
    for (const [k, seq] of lastSeqByChannel) {
      const idx = k.indexOf(":");
      const ct = Number(k.slice(0, idx));
      const cid = k.slice(idx + 1);
      await syncChannel(ct, cid, seq);
    }
  }

  const socket = new WKSocket({
    wsUrl,
    uid: robotId,
    token: creds.im_token,
    onConnected: () => {
      log("WS 已连接");
      sendHeartbeat({ apiUrl, botToken }).catch(() => {});
      if (everConnected) {
        // 这是一次重连：补拉断线期间漏掉的消息
        catchUpAll().catch((e) => log("catchUpAll 异常:", e));
      }
      everConnected = true;
    },
    onDisconnected: () => log("WS 断开，自动重连中…"),
    onError: (e) => log("WS 错误:", e?.message || e),
    onMessage: (msg) => handleInbound(msg),
  });

  socket.connect();

  // 心跳保活（在线状态）
  setInterval(() => sendHeartbeat({ apiUrl, botToken }).catch(() => {}), 30000);

  process.on("SIGINT", () => { log("收到 SIGINT，断开退出"); try { socket.disconnect(); } catch {} process.exit(0); });
  process.on("SIGTERM", () => { log("收到 SIGTERM，断开退出"); try { socket.disconnect(); } catch {} process.exit(0); });
}

main().catch((e) => { log("致命错误:", e); process.exit(1); });
