// Octo (WukongIM) <-> Claude Code 瘦桥
//
// 一头：复用 octo 扩展编译好的 WKSocket / REST 接口连 Octo（不重写加密 WS 协议）
// 一头：把收到的私聊消息交给本机 claude CLI（cwd=Workspace，读 CLAUDE.md / 记忆 / 技能）
// token 不硬编码——运行时从 ~/.openclaw/openclaw.json 读取。

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const OCTO_DIST = "/Users/mlamp/.openclaw/extensions/octo/dist/src";
const { WKSocket } = await import(join(OCTO_DIST, "socket.js"));
const { registerBot, sendMessage, sendTyping, sendHeartbeat, sendReadReceipt, postJson } =
  await import(join(OCTO_DIST, "api-fetch.js"));
const { uploadAndSendMedia } = await import(join(OCTO_DIST, "inbound.js"));

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
//   hermes         — spawn 本机 hermes CLI（cwd=HERMES_CWD，Hermes Agent 本体阿爱）
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

// ---- Hermes 后端配置（仅 AGENT_BACKEND=hermes 时使用）----
const HERMES_BIN = process.env.HERMES_BIN || "/Users/mlamp/.local/bin/hermes";
const HERMES_CWD = process.env.HERMES_CWD || "/Users/mlamp/Workspace/jphermes";
const HERMES_MODEL = process.env.HERMES_MODEL || "";        // 空 = 用 hermes 默认模型
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS || 300000);
// 完整权限（对等 jpcodex 的 danger）：--yolo 跳过危险命令审批 + --accept-hooks 自动批 shell hook
const HERMES_FULL_ACCESS = process.env.HERMES_FULL_ACCESS === "1";

// ---- Buddy 后端配置（仅 AGENT_BACKEND=buddy 时使用）----
// codebuddy 是 Claude Code 的同构 fork：-p / --output-format / --permission-mode /
// --session-id / --resume / --append-system-prompt / --model 全兼容，故复用 runClaude 模式。
const BUDDY_BIN = process.env.BUDDY_BIN ||
  "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
const BUDDY_CWD = process.env.BUDDY_CWD || "/Users/mlamp/Workspace/jpbuddy";
const BUDDY_PERMISSION_MODE = process.env.BUDDY_PERMISSION_MODE || "bypassPermissions";
const BUDDY_MODEL = process.env.BUDDY_MODEL || "auto";   // 空 = 不传 --model
const BUDDY_TIMEOUT_MS = Number(process.env.BUDDY_TIMEOUT_MS || 300000);

// ---- 视觉回声（任务胶囊）配置 ----
//   VISUAL_ECHO=on（默认）解析 <!-- mission-capsule --> 块、生成 artifact、私聊 owner 异步发图
//   VISUAL_ECHO=off 整套视觉旁路彻底关闭（主回复行为与改动前完全一致，便于验收对照/回退）
const VISUAL_ECHO = (process.env.VISUAL_ECHO || "on").toLowerCase();
const VISUAL_RUNS_DIR = process.env.VISUAL_RUNS_DIR || join(BRIDGE_DIR, "runs");
// artifact 目录里的 <agent> 段：默认用后端名，plist 可覆盖成 jpcodex/jpclaude 等
const VISUAL_AGENT = process.env.VISUAL_AGENT || AGENT_BACKEND;

// 任务胶囊输出约定：VISUAL_ECHO=on 时折进每个后端的 appendSystem，让本体在实际任务后
// 自动追加一个结构化块，由 bridge 解析渲染成视觉卡。只在 IM 场景生效，不污染终端直跑的本体。
const CAPSULE_INSTRUCTION =
  "【任务胶囊】当你完成的是一个有过程的实际任务（涉及读取/执行/修改/验证等步骤）时，" +
  "在回复正文最后追加且仅追加一个 HTML 注释块：<!-- mission-capsule {JSON} -->。" +
  "JSON 字段：title(任务标题)、status、statusLabel(中文：已完成/进行中/部分完成/失败)、" +
  "stages(固定四阶段数组，每项含 name(scout/forge/prove/report)、label(探查/执行/验证/汇报)、" +
  "state(done/running/pending/failed)、stateLabel(中文)、summary(一句话)、可选 why)、" +
  "result(结果摘要)、correctness(0~1 小数或 null)、correctnessLabel(高/中/低/未验证)、" +
  "correctnessBasis(正确率依据)、why(为什么这么做/这么判断，必填)、可选 evidence(证据数组)。" +
  "规则：correctness 必须有据、绝不编造，没有验证手段就填 null + 未验证；注释块只发一个、放最末尾；" +
  "纯闲聊或简单问答不要加这个块；块内绝不能出现 token、密钥、Authorization、cookie 等敏感信息。";
const CAPSULE_SUFFIX = VISUAL_ECHO === "on" ? "\n\n" + CAPSULE_INSTRUCTION : "";

const APPEND_SYSTEM_DM =
  "你正在通过 Octo IM 和姜哥私聊。直接用中文口语化回复，简洁，不要用 markdown 标题或大段列表。" +
  CAPSULE_SUFFIX;
const APPEND_SYSTEM_GROUP =
  "你正在通过 Octo IM 的群聊里和姜哥对话（群里还有其他人，但只有姜哥能使唤你）。" +
  "回复要更简短聚焦，只答被问到的，别刷屏，别用 markdown 标题或大段列表。" +
  CAPSULE_SUFFIX;
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

// 会话 key（私聊=对端 uid，群聊=群 channel_id）-> 稳定 UUID（buddy 后端 --session-id 续接用）
function sessionUuid(key) {
  const h = createHash("md5").update(`octo:${ACCOUNT_ID}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// claude 2.1.168 的 headless `--resume`/`--session-id 续接` 会挂死（无输出直到被超时杀掉，
// 在任意 cwd、清空 stdin、全新 session 下都复现，是 CLI 这一版的 bug），所以瘦桥不再用磁盘
// session 续接。改为：每次全新会话 + 自己在内存里维护每个会话最近几轮对话，折叠进 prompt，
// 既保证短期上下文连续，又避开 --resume 挂死。长期记忆仍由 cwd 的 CLAUDE.md/记忆系统兜底。
const CLAUDE_HISTORY_TURNS = 6; // 每会话保留最近 6 轮（user+assistant）
const claudeHistory = new Map(); // sessionKey -> [{ role:"user"|"assistant", text }]

function runClaude(sessionKey, text, appendSystem) {
  const hist = claudeHistory.get(sessionKey) || [];
  const transcript = hist.length
    ? "最近对话（按时间顺序，便于你延续上下文）：\n" +
      hist.map((h) => `${h.role === "user" ? "对方" : "你"}：${h.text}`).join("\n") + "\n\n"
    : "";
  const prompt = `${transcript}当前对方消息：\n${text}`;
  const args = ["-p", "--output-format", "text", "--permission-mode", PERMISSION_MODE,
    // 禁用所有 MCP：cwd=Workspace 会继承全套 .mcp.json(playwright/context7 等)，
    // 每次 -p 冷启动这些重型 server 要几十秒~数分钟，IM 群聊场景用不到，禁掉换秒级响应。
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--append-system-prompt", appendSystem];
  return new Promise((resolve) => {
    // prompt 走 stdin（避免 argv 转义/长度问题，并立即 end 防 claude 等 3s stdin）
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKSPACE, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const o = out.trim();
      if (code === 0 && o) {
        const next = [...hist, { role: "user", text }, { role: "assistant", text: o }]
          .slice(-CLAUDE_HISTORY_TURNS * 2);
        claudeHistory.set(sessionKey, next);
      }
      resolve({ code, out: o, err: err.trim() });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e) }); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch {}
  });
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

// ---- Hermes 后端 ----
// hermes -z 是 headless 单次执行：只打印最终回复到 stdout，自动 bypass 审批，
// 读 cwd 的 AGENTS.md / 记忆 / 工具。会话续接靠 --continue <稳定名>（不存在则自动建）。
function runHermes(sessionKey, text, appendSystem) {
  // hermes -z 没有 --append-system-prompt，把场景说明折叠进 prompt（同 codex）
  const prompt = `${appendSystem}\n\n当前用户消息：\n${text}`;
  const sessionName = `octo-${ACCOUNT_ID}-${sessionKey}`;
  const modelArgs = HERMES_MODEL ? ["-m", HERMES_MODEL] : [];
  const accessArgs = HERMES_FULL_ACCESS ? ["--yolo", "--accept-hooks"] : [];
  return new Promise((resolve) => {
    // --continue <name> 放在 -z 前；--continue 的可选参数 nargs='?' 会吃掉紧跟的非选项 token
    const args = ["--continue", sessionName, ...accessArgs, ...modelArgs, "-z", prompt];
    const child = spawn(HERMES_BIN, args, { cwd: HERMES_CWD, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, HERMES_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e) }); });
  });
}

// ---- Buddy 后端（codebuddy，WorkBuddy 的内嵌 CLI，Claude Code 同构 fork）----
function runBuddy(sessionKey, text, appendSystem) {
  const sid = sessionUuid(sessionKey);
  const modelArgs = BUDDY_MODEL ? ["--model", BUDDY_MODEL] : [];
  const base = ["-p", "--output-format", "text", "--permission-mode", BUDDY_PERMISSION_MODE,
    "--append-system-prompt", appendSystem, ...modelArgs];
  const tryRun = (sessionArgs) =>
    new Promise((resolve) => {
      const args = [...base, ...sessionArgs, text];
      const child = spawn(BUDDY_BIN, args, { cwd: BUDDY_CWD, env: process.env });
      let out = "", err = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, BUDDY_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e) }); });
    });

  return (async () => {
    // 续接优先（同 claude：--resume <id> / --session-id <id>，session 由确定性 UUID 持久化）
    const r = await tryRun(["--resume", sid]);
    if (r.code === 0 && r.out) return r;
    const created = await tryRun(["--session-id", sid]);
    if (created.code === 0 && created.out) return created;
    if (/already in use/i.test(created.err || "")) {
      const re = await tryRun(["--resume", sid]);
      if (re.code === 0 && re.out) return re;
    }
    // codebuddy 偶发 429（版本限流弹窗，headless 下跳过致空输出）：续接重试一次兜底
    const retry = await tryRun(["--resume", sid]);
    if (retry.code === 0 && retry.out) return retry;
    return created;
  })();
}

// 统一入口：按 AGENT_BACKEND 分发
function runAgent(sessionKey, text, appendSystem) {
  if (AGENT_BACKEND === "codex") return runCodex(sessionKey, text, appendSystem);
  if (AGENT_BACKEND === "hermes") return runHermes(sessionKey, text, appendSystem);
  if (AGENT_BACKEND === "buddy") return runBuddy(sessionKey, text, appendSystem);
  return runClaude(sessionKey, text, appendSystem);
}

// ========== 视觉回声（任务胶囊）==========
// resvg 仅在真正渲染 PNG 时才动态加载，避免 VISUAL_ECHO=off 时引入依赖。
let _Resvg = null;
async function getResvg() {
  if (_Resvg === null) {
    const mod = await import("@resvg/resvg-js");
    _Resvg = mod.Resvg;
  }
  return _Resvg;
}

// 解析 Agent 文本里的 <!-- mission-capsule {json} --> 块。
// 只取第一个、非贪婪；解析失败一律降级（返回原文 + capsule:null），绝不影响主回复。
function parseMissionCapsule(text) {
  const src = String(text ?? "");
  const m = src.match(/<!--\s*mission-capsule\s*([\s\S]*?)-->/);
  if (!m) return { displayText: src, capsule: null };
  let capsule = null;
  try {
    capsule = JSON.parse(m[1].trim());
  } catch {
    return { displayText: src, capsule: null }; // JSON 坏：原文照发，不生成卡
  }
  const displayText = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();
  return { displayText, capsule };
}

// 敏感信息过滤：按已知前缀/上下文精确替换，不用 {32,} 通配（避免误杀 hash/id）。
// 发图=上传公网 CDN，渲染进图/写进 artifact 的每个字段都必须先过这一关。
function redactSecrets(input) {
  let s = String(input ?? "");
  s = s.replace(/bf_[A-Za-z0-9_-]+/g, "bf_REDACTED");
  s = s.replace(/sk-[A-Za-z0-9_-]+/g, "sk_REDACTED");
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer REDACTED");
  s = s.replace(/(authorization)\s*:\s*\S+/gi, "$1: REDACTED");
  s = s.replace(/([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*\S+/g, "$1=REDACTED");
  s = s.replace(/(cookie)\s*[:=]\s*\S+/gi, "$1=REDACTED");
  return s;
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// 同时过滤敏感信息 + XML 转义（所有进 SVG 的文本必走）
function safe(s) {
  return xmlEscape(redactSecrets(s));
}

// 按显示宽度折行：CJK 记 1 单位、ASCII 记 0.5；尊重原文 \n。
function wrapText(text, maxUnits) {
  const out = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    let cur = "", units = 0;
    for (const ch of rawLine) {
      const w = /[\x00-\xff]/.test(ch) ? 0.5 : 1;
      if (units + w > maxUnits && cur) { out.push(cur); cur = ""; units = 0; }
      cur += ch; units += w;
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}

const STATE_COLOR = {
  done: "#34d399", completed: "#34d399",
  running: "#60a5fa",
  pending: "#9ca3af", queued: "#9ca3af",
  failed: "#f87171", blocked: "#f87171",
  "needs-confirmation": "#fbbf24", partial: "#fbbf24",
};
function correctnessColor(label) {
  if (label === "高") return "#34d399";
  if (label === "中") return "#fbbf24";
  if (label === "低") return "#f87171";
  return "#9ca3af";
}

// 生成酷炫结果卡 SVG（深色底 + 渐变 + 圆角 + 阶段进度）。
// 所有填入字段先过 safe()（过滤 + 转义）。
function buildCapsuleSvg(capsule, shortId) {
  const W = 1080, PAD = 64, X = PAD, CW = W - PAD * 2;
  const parts = [];
  let y = 96;

  // 标题
  for (const line of wrapText(capsule.title || "任务胶囊", 24)) {
    parts.push(`<text x="${X}" y="${y}" fill="#f8fafc" font-size="46" font-weight="700">${safe(line)}</text>`);
    y += 60;
  }
  // 状态徽标
  const statusLabel = capsule.statusLabel || capsule.status || "";
  if (statusLabel) {
    parts.push(`<text x="${X}" y="${y}" fill="#a5b4fc" font-size="28" font-weight="600">● ${safe(statusLabel)}</text>`);
    y += 28;
  }
  y += 24;
  parts.push(`<line x1="${X}" y1="${y}" x2="${X + CW}" y2="${y}" stroke="#334155" stroke-width="2"/>`);
  y += 52;

  // 四阶段进度
  const stages = Array.isArray(capsule.stages) ? capsule.stages : [];
  for (const st of stages) {
    const color = STATE_COLOR[st.state] || "#9ca3af";
    const head = `${st.label || st.name || ""}　${st.stateLabel || st.state || ""}`;
    parts.push(`<circle cx="${X + 10}" cy="${y - 10}" r="11" fill="${color}"/>`);
    parts.push(`<text x="${X + 38}" y="${y}" fill="#e2e8f0" font-size="30" font-weight="600">${safe(head)}</text>`);
    y += 38;
    if (st.summary) {
      for (const line of wrapText(st.summary, 40)) {
        parts.push(`<text x="${X + 38}" y="${y}" fill="#94a3b8" font-size="25">${safe(line)}</text>`);
        y += 34;
      }
    }
    y += 14;
  }

  y += 18;
  parts.push(`<line x1="${X}" y1="${y}" x2="${X + CW}" y2="${y}" stroke="#334155" stroke-width="2"/>`);
  y += 52;

  // 字段块通用绘制
  const block = (label, value, valueColor = "#e2e8f0") => {
    if (value == null || value === "") return;
    parts.push(`<text x="${X}" y="${y}" fill="#64748b" font-size="24" font-weight="600">${safe(label)}</text>`);
    y += 38;
    for (const line of wrapText(value, 42)) {
      parts.push(`<text x="${X}" y="${y}" fill="${valueColor}" font-size="28">${safe(line)}</text>`);
      y += 40;
    }
    y += 18;
  };

  block("结果", capsule.result);
  const corrLabel = capsule.correctnessLabel || "未验证";
  const corrText = capsule.correctnessBasis
    ? `${corrLabel}（${capsule.correctnessBasis}）` : corrLabel;
  block("正确率", corrText, correctnessColor(corrLabel));
  block("为什么", capsule.why);
  if (capsule.evidence != null && capsule.evidence !== "") {
    const ev = Array.isArray(capsule.evidence) ? capsule.evidence.join("，") : capsule.evidence;
    block("证据", ev, "#cbd5e1");
  }

  // 页脚：短 id + agent
  y += 8;
  parts.push(`<text x="${X}" y="${y}" fill="#475569" font-size="22">${safe(VISUAL_AGENT)} · ${safe(shortId)}</text>`);
  y += 40;

  const H = y + PAD - 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="PingFang SC, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#1e1b4b"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" rx="36" fill="url(#bg)"/>
  <rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="32" fill="none" stroke="#3730a3" stroke-width="2" opacity="0.5"/>
  ${parts.join("\n  ")}
</svg>`;
}

async function renderPng(svg) {
  const Resvg = await getResvg();
  const r = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } });
  return r.render().asPng();
}

// 人类可读复盘（已过滤），写 summary.md
function buildSummaryMd(capsule) {
  const lines = [];
  lines.push(`# ${redactSecrets(capsule.title || "任务胶囊")}`);
  lines.push("");
  if (capsule.statusLabel || capsule.status) lines.push(`状态：${redactSecrets(capsule.statusLabel || capsule.status)}`);
  if (capsule.result) lines.push(`结果：${redactSecrets(capsule.result)}`);
  const corr = capsule.correctnessLabel || "未验证";
  lines.push(`正确率：${redactSecrets(corr)}${capsule.correctnessBasis ? `（${redactSecrets(capsule.correctnessBasis)}）` : ""}`);
  if (capsule.why) lines.push(`为什么：${redactSecrets(capsule.why)}`);
  lines.push("");
  lines.push("## 阶段");
  for (const st of (Array.isArray(capsule.stages) ? capsule.stages : [])) {
    lines.push(`- ${redactSecrets(st.label || st.name || "")} ${redactSecrets(st.stateLabel || st.state || "")}` +
      (st.summary ? `：${redactSecrets(st.summary)}` : "") +
      (st.why ? `（为什么：${redactSecrets(st.why)}）` : ""));
  }
  return lines.join("\n") + "\n";
}

// 视觉副通道主体：fire-and-forget。全程 try/catch，任何失败只 log，绝不抛、绝不影响主回复。
async function runVisualEcho({ capsule, isDM, isOwner, channelId, channelType, apiUrl, botToken }) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const shortId = randomBytes(2).toString("hex");
    const dir = join(VISUAL_RUNS_DIR, VISUAL_AGENT, `${ts}-${shortId}`);
    mkdirSync(dir, { recursive: true });

    // run.json：结构化任务胶囊（含 correctness/why），写盘前过滤敏感串
    const runObj = JSON.parse(redactSecrets(JSON.stringify({
      id: `${ts}-${shortId}`, agent: VISUAL_AGENT, backend: AGENT_BACKEND, ...capsule,
    })));
    writeFileSync(join(dir, "run.json"), JSON.stringify(runObj, null, 2));
    writeFileSync(join(dir, "summary.md"), buildSummaryMd(capsule));

    // SVG 本地存档；PNG 才是发进 IM 的（SVG 无宽高，客户端渲染异常）
    const svg = buildCapsuleSvg(capsule, shortId);
    writeFileSync(join(dir, "capsule.svg"), svg);

    let pngPath = null;
    try {
      const png = await renderPng(svg);
      pngPath = join(dir, "capsule.png");
      writeFileSync(pngPath, png);
    } catch (e) {
      log(`视觉卡 PNG 渲染失败（已留 run.json/svg）: ${e?.message || e}`);
    }

    // 只有私聊 owner 才发图：图会上公网 CDN，群聊/非 owner 永不发
    if (pngPath && isDM && isOwner) {
      await uploadAndSendMedia({
        mediaUrl: pngPath, apiUrl, botToken, channelId, channelType, log,
      });
      log(`visual card sent (${VISUAL_AGENT}/${ts}-${shortId})`);
    } else {
      log(`visual card 已生成未发图 dm=${isDM} owner=${isOwner} (${VISUAL_AGENT}/${ts}-${shortId})`);
    }
  } catch (e) {
    log("runVisualEcho 失败（仅记录，不影响主回复）:", e?.message || e);
  }
}

async function main() {
  const { botToken, apiUrl } = loadCreds();
  if (AGENT_BACKEND === "codex") {
    log(`瘦桥启动 backend=codex account=${ACCOUNT_ID} api=${apiUrl} codex_cwd=${CODEX_CWD} model=${CODEX_MODEL || "(default)"} danger=${CODEX_DANGER_FULL_ACCESS}`);
  } else if (AGENT_BACKEND === "hermes") {
    log(`瘦桥启动 backend=hermes account=${ACCOUNT_ID} api=${apiUrl} hermes_cwd=${HERMES_CWD} model=${HERMES_MODEL || "(default)"} full_access=${HERMES_FULL_ACCESS}`);
  } else if (AGENT_BACKEND === "buddy") {
    log(`瘦桥启动 backend=buddy account=${ACCOUNT_ID} api=${apiUrl} buddy_cwd=${BUDDY_CWD} model=${BUDDY_MODEL || "(default)"} perm=${BUDDY_PERMISSION_MODE}`);
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
        // 解析任务胶囊：主回复发的是剥掉 <!-- mission-capsule --> 块的正文
        const { displayText, capsule } = VISUAL_ECHO === "on"
          ? parseMissionCapsule(reply)
          : { displayText: reply, capsule: null };
        const sendText = displayText || reply;
        await sendMessage({ apiUrl, botToken, channelId, channelType, content: sendText });
        log(`已回复 (${sendText.length} 字)`);
        // 视觉副通道：fire-and-forget，绝不 await、绝不影响主回复速度
        if (VISUAL_ECHO === "on" && capsule) {
          const isOwner = isDM ? !!(ownerUid && msg.from_uid === ownerUid) : true;
          log("visual job queued");
          void runVisualEcho({
            capsule, isDM, isOwner, channelId, channelType, apiUrl, botToken,
          }).catch((e) => log("visual job failed:", e?.message || e));
        }
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

if (process.env.BRIDGE_NO_MAIN !== "1") {
  main().catch((e) => { log("致命错误:", e); process.exit(1); });
}

export { parseMissionCapsule, redactSecrets, buildCapsuleSvg, renderPng, buildSummaryMd };
