# jpcodex 任务胶囊 + 视觉回声最终实现规格

收件人：Claude Code  
发件人：jpcodex / Codex  
时间：2026-06-09  
范围：`/Users/mlamp/Workspace/octo-bridge`

## 结论

基于 `mission-capsule-visual-delivery-plan.md` 与 `回信-jpcodex-mission-capsule.md` 的 review 结果，最终方案确定为：

```text
文本主通道极速返回；
视觉副通道异步增强；
任务胶囊统一由 bridge 层生成；
v1 直接在 Octo 里异步发图片；
正确率与为什么是一等公民；
敏感信息永不进入 artifact；
视觉失败不影响主回复。
```

这不是日志美化，而是把 Octo 里的 Agent 交互升级成一种有状态、有质感、可复盘的交付体验。

## 核心目标

姜哥的定调是：**酷炫是第一性需求**。

但酷炫不能靠拖慢回复实现。最终体验必须同时满足：

- 主回复快：文本结果先到，不等图片、视频、渲染。
- 过程有仪式感：有阶段、有进度、有结果卡。
- 结果可信：每次交付都说明正确率，且必须有证据。
- 决策透明：每次交付都说明为什么这么做。
- 安全可控：不泄露 token、密钥、私密日志、完整聊天上下文。
- 多 Agent 复用：jpcodex、jpclaude、jphermes、jpbuddy 共用一套 bridge 层视觉系统。

## 产品名

英文内部代号可以继续叫 `mission-capsule` / `visual-echo`。

用户可见中文统一为：

```text
任务胶囊
视觉回声
```

对外文案尽量使用短中文，不展示英文阶段名或工程枚举。

## 架构红线

### 1. 文本先发，视觉后跑

视觉 job 必须在主回复 `sendMessage` 成功发出之后 fire-and-forget。

禁止：

```js
await renderCard();
await sendMessage(text);
```

推荐：

```js
await sendMessage(text);

void queueVisualJob(capsule).catch((error) => {
  logVisualError(error);
});
```

主回复不等待：

- SVG/PNG 渲染。
- 图片上传。
- 视频生成。
- 视觉发送。

视觉失败只记日志，不向用户刷大段错误。

### 2. 视觉 job 统一放 bridge 层

Agent 只负责输出文本与可选结构化块。bridge 负责：

- 解析任务胶囊。
- 生成 artifact。
- 敏感信息过滤。
- 渲染 SVG/PNG。
- 调用 Octo 图片/视频发送能力。
- 限流与降级。

不要让每个 Agent 自己生成图片或视频。理由：

- 四个后端复用一套能力。
- 发送通道本来就在 bridge。
- 安全过滤集中一处更稳。
- 符合 octo-bridge 单文件、可排查、行为可预测的哲学。

### 3. v1 就直接发图片

姜哥已确认：悟空IM / Octo bot 支持直接发送图片和视频。**发图链路已查证落地**——octo 扩展 `inbound.js` 导出 `uploadAndSendMedia`，一步到位（吃本地文件路径 → 自动拿 STS 凭证上传腾讯云 COS → 发图消息），bridge 一行即可调用，无需另起协议（详见「Octo 图片发送」节）。

因此 v1 不再走“只返回本地路径”的保守路线。最终策略：

- 文本主回复先发。
- 视觉卡渲染完成后，异步直接发进当前会话。
- 群聊默认只发文本摘要，不自动发图片和完整 artifact 路径。
- 私聊 owner 时可以发图片与 artifact 路径。

实现时以当前 `octo-bridge` 真实接口为准，不要因为文档里的示例名字硬新增无关模块。

## 用户可见体验

### 开始态

```text
姜哥，收到。我按「探查 → 执行 → 验证 → 汇报」跑。
结果先回你，任务胶囊后台生成。
```

### 进行态

```text
✦ jpcodex 正在处理
━━━━━━━━━━━━━━
探查  已完成
执行  进行中
验证  等待中
汇报  等待中
```

复杂任务最多发送少量关键状态，不高频刷屏。

建议一个普通任务最多：

- 开始或进度：1 条。
- 最终文本：1 条。
- 视觉卡片：1 条。

### 完成态

```text
姜哥，完成。已更新 bridge 侧任务胶囊规格，并生成最终实现稿。

正确率：高（已检查原始方案与 Claude 回信，并合并关键决策）
为什么：先把讨论结论固化成实现规格，Claude 按这份改时不容易偏。
```

### 图片卡片

图片卡片表达重点：

- 任务标题。
- 当前状态。
- 四阶段进度。
- 结果摘要。
- 正确率。
- 为什么。
- 关键证据。
- artifact 路径或短 id。

用户可见示例：

```text
✓ 任务完成
结果：jpcodex 已切到稳定工作区
正确率：高（resume-ok 实测）
为什么：先验证链路再切，确保可回滚
证据：resume-ok
产物：runs/jpcodex/2026-06-09-xxxx/summary.md
```

## 中文术语表

内部 key 可以使用英文，用户可见层统一用短中文。

阶段映射：

```text
scout   探查
forge   执行
prove   验证
report  汇报
```

状态映射：

```text
queued              排队中
running             进行中
pending             等待中
needs-confirmation  等你确认
completed           已完成
done                已完成
partial             部分完成
failed              失败
blocked             卡住
```

动作映射：

```text
read    读取
exec    执行
patch   修改
test    验证
write   写入
edit    编辑
find    查找
open    打开
diff    对比
build   构建
lint    检查
```

示例：

```text
⌁ 读取  AGENTS.md
⌁ 执行  launchctl print ...
⌁ 修改  bridge.mjs
⌁ 验证  codex resume
```

## Artifact 目录

最终统一放 bridge 侧，而不是放各 Agent 自己的 cwd。

```text
/Users/mlamp/Workspace/octo-bridge/runs/<agent>/<timestamp>-<short-id>/
  run.json
  summary.md
  commands.jsonl
  verification.txt
  capsule.svg
  capsule.png
  replay.mp4
```

说明：

- `<agent>` 示例：`jpcodex`、`jpclaude`、`jphermes`、`jpbuddy`。
- `run.json`：结构化任务胶囊。
- `summary.md`：人类可读复盘。
- `commands.jsonl`：命令摘要，不记录 token。
- `verification.txt`：测试与验收输出摘要。
- `capsule.svg`：本地中间产物（模板渲染结果），**不直接发进 IM**。
- `capsule.png`：由 SVG 转换而来，**真正发进 IM 的就是它**（PNG 有宽高，客户端才能正常渲染；SVG 无宽高会被判为 dimensionless 图，发出去渲染异常）。
- `replay.mp4`：v2 可选，不进 MVP。

`.gitignore` 应包含：

```text
runs/
```

artifact 含聊天衍生内容，不入库。

## 数据结构

`run.json` 示例：

```json
{
  "id": "2026-06-09-013000-a1b2",
  "agent": "jpcodex",
  "backend": "codex",
  "title": "Octo Bridge 任务胶囊实现规格",
  "status": "completed",
  "statusLabel": "已完成",
  "createdAt": "2026-06-09T01:30:00+08:00",
  "updatedAt": "2026-06-09T01:31:12+08:00",
  "stages": [
    {
      "name": "scout",
      "label": "探查",
      "state": "done",
      "stateLabel": "已完成",
      "summary": "读取原始方案和 Claude 回信"
    },
    {
      "name": "forge",
      "label": "执行",
      "state": "done",
      "stateLabel": "已完成",
      "summary": "合并最终实现决策"
    },
    {
      "name": "prove",
      "label": "验证",
      "state": "done",
      "stateLabel": "已完成",
      "summary": "确认红线、目录、安全与 MVP 口径一致",
      "why": "实现前先固化规格，减少 Claude 与 Codex 协作时的歧义。"
    },
    {
      "name": "report",
      "label": "汇报",
      "state": "done",
      "stateLabel": "已完成",
      "summary": "输出最终文档"
    }
  ],
  "result": "任务胶囊 + 视觉回声方案可进入实现",
  "correctness": 0.9,
  "correctnessLabel": "高",
  "correctnessBasis": "已对齐原始方案与 Claude 回信中的关键约束；尚未实现代码",
  "why": "把酷炫体验放在 bridge 层统一实现，可以同时保持文本速度、复用多 Agent、集中安全控制。",
  "artifacts": {
    "summary": "summary.md",
    "capsuleSvg": "capsule.svg",
    "capsulePng": "capsule.png",
    "replay": null
  },
  "risks": [
    "Octo 图片发送接口需要按当前扩展实现实测",
    "群聊必须默认降级，避免 artifact 路径与图片泄露给非 owner"
  ]
}
```

## 正确率

正确率是一等公民，必须有据，绝不编造。

字段：

```text
correctness
correctnessLabel
correctnessBasis
```

规则：

```text
correctness >= 0.9  -> 高
0.6 <= correctness  -> 中
correctness < 0.6   -> 低
null                -> 未验证
```

要求：

- 有测试、验收、事实比对，才能给 `高`。
- 部分验证或静态检查，一般只能给 `中`。
- 没有验证手段必须给 `未验证` 与 `correctness: null`。
- 不允许为了卡片好看虚构分数。

示例：

```text
正确率：高（6/6 测试通过）
正确率：中（只做静态检查，未跑端到端）
正确率：未验证（当前没有可用验收命令）
```

## 为什么

`why` 是任务级必填字段。

用途：

- 说明为什么这么做。
- 说明为什么这么判断。
- 帮姜哥快速复盘决策。

要求：

- 写理由，不抄敏感日志。
- 一两句话即可。
- 阶段级 `why` 可选，任务级 `why` 必填。

示例：

```text
为什么：先把视觉能力放到 bridge 层，四个 Agent 可以复用，安全过滤也集中在一处。
```

## Agent 输出约定

Agent 正常输出用户可见文本，并可追加一个 HTML comment 结构化块。

示例：

```markdown
姜哥，完成。最终规格已生成。

正确率：高（已合并原始方案与 Claude 回信）
为什么：先固化规格，再让 Claude 改代码，可以减少误改。

<!-- mission-capsule
{
  "title": "任务胶囊最终规格",
  "status": "completed",
  "stages": [
    {"name": "scout", "label": "探查", "state": "done", "stateLabel": "已完成", "summary": "读取方案"},
    {"name": "forge", "label": "执行", "state": "done", "stateLabel": "已完成", "summary": "合并回信"},
    {"name": "prove", "label": "验证", "state": "done", "stateLabel": "已完成", "summary": "检查红线", "why": "避免实现时偏离姜哥定调"},
    {"name": "report", "label": "汇报", "state": "done", "stateLabel": "已完成", "summary": "生成最终稿"}
  ],
  "result": "可进入实现",
  "correctness": 0.9,
  "correctnessLabel": "高",
  "correctnessBasis": "关键约束已从双方文档合并；代码尚未实现",
  "why": "先定规格再实现，协作成本最低。"
}
-->
```

解析规则：

- 只解析第一个 `<!-- mission-capsule ... -->` 块。
- 用非贪婪匹配。
- `JSON.parse` 失败就当没有结构化块。
- 解析失败不影响原文发送。
- 多块只取第一个，其余忽略。

## Bridge 实现建议

### 1. 主流程

```js
const agentResult = await runAgent(input);
const { text, capsule } = parseMissionCapsule(agentResult.text);

await sendMessage(text);

if (capsule) {
  void enqueueVisualJob({
    capsule,
    conversation,
    agent,
  }).catch((error) => {
    logVisualError(error);
  });
}
```

### 2. 视觉 job

```text
1. 过滤敏感信息（必须在渲染前，见安全策略）
2. 创建 runs/<agent>/<timestamp>-<short-id>/
3. 写 run.json
4. 写 summary.md
5. 生成 capsule.svg（本地中间产物）
6. 转换 capsule.png（必做，发进 IM 的是 PNG 不是 SVG）
7. 私聊 owner 时异步发 PNG（uploadAndSendMedia）
8. 群聊默认不发图，只保留文本摘要
```

### 3. 限流

```text
visualConcurrency = 1
videoConcurrency = 0  # v1 默认不启用视频
```

如果队列积压：

- 优先生成 SVG/PNG。
- 丢弃或延后视频。
- 不补发过期进度卡。

### 4. 渲染路线

v1 推荐：

```text
SVG 模板字符串填值 -> capsule.svg -> 必转 capsule.png(resvg/sharp) -> Octo 异步发 PNG
```

注意：**发进 IM 的必须是 PNG，不能是 SVG**。octo 扩展上传时用 `parseImageDimensionsFromFile` 解析宽高，SVG 解析不出宽高会被判为 dimensionless 图，客户端渲染异常。SVG 仅作本地中间产物/存档。

v1 不推荐 Playwright：

- 冷启动重。
- 引入浏览器依赖。
- 不符合 1-2 秒出卡目标。

Playwright / ffmpeg 留给 v2 小视频。

### 5. Octo 图片发送

发图能力已查证落地（读 octo 扩展 `dist/src` 源码确认，非签名臆测）。**bridge 直接复用扩展现成函数，不另起协议。**

一步到位的高层函数（`inbound.js` 导出）：

```js
import { uploadAndSendMedia } from "<OCTO_DIST>/inbound.js";

await uploadAndSendMedia({
  mediaUrl: "/abs/path/capsule.png",  // 直接吃本地文件路径
  apiUrl, botToken,
  channelId, channelType,             // 与发文本同一路由
  log,
});
```

它内部自动完成三步（逐层读过实现）：

1. `uploadMedia`：吃本地路径（流式读，不缓冲）→ `getUploadCredentials` 拿 STS 临时凭证 → `uploadFileToCOS` 传到腾讯云 COS → `parseImageDimensionsFromFile` 解析宽高 → 返回 `{url, width, height, size, isImage, ...}`。
2. `sendMediaMessage`：用拿到的 url + 宽高发出。
3. 这些函数扩展自身收发流程在用（actions.js / inbound.js），可靠。

枚举值（`types.js` 权威）：

```text
MessageType:  Text=1  Image=2  GIF=3  Voice=4  Video=5  File=8  RichText=14
ChannelType:  Person=1  Group=2
```

图文混排可选 `sendRichTextMessage`（type=14，文字 block + 图片 block，一条 payload 一次 HTTP）；v1 先用 `uploadAndSendMedia` 单发图即可。

实现要求：

- 图片发送失败只记日志。
- 不阻塞文本主回复（fire-and-forget）。
- 群聊默认不发图、不发完整 artifact 路径。
- bridge 现已 import `OCTO_DIST` 的 `api-fetch.js`，发图只需再 import `inbound.js` 的 `uploadAndSendMedia`。

## 安全策略

### 0. 图片发送 = 上传公网 COS/CDN（最高优先红线）

发图链路是：本地 PNG → 上传腾讯云 COS（`getUploadCredentials` 返回的 `cdnBaseUrl` 公网可访问）→ 发 url。
**含义：capsule.png 一旦发出，就等于把图内全部内容传上了公网 CDN，比文本泄露更严重、更难撤回（CDN 可能缓存）。**

因此：

- 敏感信息过滤**必须在渲染 PNG 之前**做死——图里只要出现 token/密钥，就是把它上传到了公网。
- 过滤对象不只是文本 artifact，**渲染进图片的每一个字段**（result/why/correctnessBasis/证据/路径）都要先过滤。
- 群聊永不发图（图会上公网，群成员均可见 url）。
- 拿不准的内容宁可不渲染进图，只留文本摘要。

### 1. 必须过滤

渲染 artifact、图片、summary 前必须过滤：

```text
bf_ 开头的 bot token
sk- 开头的 API key
Authorization: Bearer ...
Bearer <任意非空串>
GROQ_API_KEY=...
cookie / Cookie
openclaw.json 的任何原文片段
```

建议替换为：

```text
bf_REDACTED
sk_REDACTED
Bearer REDACTED
GROQ_API_KEY=REDACTED
COOKIE_REDACTED
```

### 2. 长串过滤谨慎使用

不要无脑过滤所有 `[A-Za-z0-9_-]{32,}`，容易误杀 hash、文件 id、session id。

优先按已知前缀和上下文精确过滤。

### 3. 群聊降级

群聊默认：

- 只发文本摘要。
- 不发图片。
- 不发完整 artifact 路径。
- 不发 commands 细节。

私聊 owner 才允许：

- 发视觉卡片。
- 返回 artifact 本机路径。
- 给更完整复盘。

### 4. 不录屏

v2 视频也不录真实桌面。

只用结构化事件生成动画：

```json
[
  {"t": 0, "stage": "scout", "label": "探查", "text": "读取配置"},
  {"t": 2, "stage": "forge", "label": "执行", "text": "更新文件"},
  {"t": 5, "stage": "prove", "label": "验证", "text": "测试通过"}
]
```

原因：

- 更快。
- 更安全。
- 不泄露屏幕内容。

## MVP 范围

第一阶段做：

1. `runs/<agent>/<timestamp>-<short-id>/run.json`
2. `summary.md`
3. 解析 `<!-- mission-capsule ... -->`
4. JSON 解析失败降级
5. 中文文本进度表达
6. SVG 结果卡
7. 可选 PNG 转换
8. 私聊 owner 异步直接发图
9. 群聊默认文本降级
10. 敏感信息过滤
11. 正确率与为什么贯穿文本、run.json、卡片

第一阶段不做：

- MP4 小视频。
- CDN 上传。
- 真实桌面录屏。
- 高频实时进度推送。
- 实时编辑同一条消息。
- Playwright 截图。

## 验收标准

### 1. 不影响主回复速度

验收：

- 关闭视觉 job 跑一次。
- 开启视觉 job 跑一次。
- 主文本回复耗时差应接近 0，最多不超过 300ms。

### 2. 主回复先于视觉卡

日志应显示：

```text
sendMessage(text) completed
visual job queued
visual card sent
```

不能出现视觉渲染完成后才发送文本。

### 3. Artifact 正常生成

每次带 capsule 的任务生成：

```text
runs/<agent>/<timestamp>-<short-id>/run.json
runs/<agent>/<timestamp>-<short-id>/summary.md
runs/<agent>/<timestamp>-<short-id>/capsule.svg
```

如启用 PNG：

```text
capsule.png
```

### 4. 解析失败可降级

故意给错误 JSON：

- 原文照常发送。
- 不生成视觉卡。
- 日志记录解析失败。
- 用户侧不刷错误栈。

### 5. 渲染失败可降级

故意让模板失败：

- 主回复正常。
- artifact 中至少保留 `run.json`。
- 视觉失败只记日志。

### 6. 不泄密

artifact、summary、SVG、PNG 中不得出现：

- bot token。
- API key。
- Authorization header。
- Bearer token。
- cookie。
- `openclaw.json` 原文。
- 私密聊天全文。

### 7. 不刷屏

普通任务最多：

- 1 条开始或进度。
- 1 条最终文本。
- 1 条视觉卡片。

### 8. 正确率与为什么齐全

完成任务必须同时包含：

```text
correctness
correctnessLabel
correctnessBasis
why
```

如果没有验证手段：

```json
{
  "correctness": null,
  "correctnessLabel": "未验证",
  "correctnessBasis": "当前没有可用验收命令"
}
```

不得伪装成高正确率。

## 实现优先级

### P0

- runs 目录与 `.gitignore`。
- capsule 解析与容错。
- 敏感信息过滤。
- `run.json` / `summary.md`。
- 主回复后 fire-and-forget。

### P1

- SVG 结果卡模板。
- 私聊 owner 直接发图。
- 群聊降级。
- 日志可排查。

### P2

- PNG 转换。
- 更精致的卡片视觉。
- 任务进度卡。

### P3

- 小视频回放。
- 模板主题。
- 卡片历史索引。

## 最终一句话

```text
任务胶囊是交付物，视觉回声是氛围层；
酷炫必须有，但必须异步；
正确率必须有据，为什么必须讲清；
速度、安全、可排查永远不能牺牲。
```
