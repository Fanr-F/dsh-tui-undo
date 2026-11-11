# opencode 的 undo / redo 实现分析

> 分析对象：本地 `D:\Code\opencode`，`opencode` 包版本 **1.17.10**，HEAD `b2c688f`（2026-06-25）。
> 目的：为 DSH Rewind（本仓库插件）等"对话回退 + 文件回退"能力提供实现参考。
> 说明：文中路径均相对 opencode 仓库根目录；`文件:行号` 为写文档时的实际位置，后续版本可能漂移。
> 配套：与本插件（DSH Rewind）实现的逐项对比见 [`undo-comparison.md`](./undo-comparison.md)。

---

## 0. 结论摘要（TL;DR）

1. **opencode 没有 undo/redo 栈**。它只有三样东西：
   - 一个**内容寻址的文件快照系统**（影子 git 仓库，只有 tree 对象，没有 commit）；
   - 每条 assistant 消息里记录若干 **`patch` part**（"这一步改了哪些文件、改动前的 tree 是哪个"）；
   - 会话级**回退水位线** `session.revert = { messageID, partID?, snapshot?, diff? }`。
2. **Undo = 把水位线往后移**：`POST /session/:id/revert { messageID }`，文件层面"先恢复到 head 快照，再按 patch 账本回滚目标消息及之后的所有步骤"，对话层面只打标记、不删消息。
3. **Redo = 把水位线往前移**：如果水位线之后还有下一条 user 消息，就再调一次 `revert(next)`——被撤掉的区间从 `[R..]` 缩小到 `[next..]`，于是 `R` 这一轮的效果重新生效；如果没有下一条了，就调 `unrevert`，用 `session.revert.snapshot` 把整棵工作树恢复回"撤销前"的状态。
4. **真正的"不可逆点"不是 redo 结束，而是下一次发消息**：`prompt` / `shell` / `summarize` 会先调用 `SessionRevert.cleanup`，把水位线之后的消息**物理删除**并清空 `revert`，此后 redo 无从谈起。
5. 同一个仓库里存在**两套实现**：
   - v1（在用）：`packages/opencode/src/snapshot/index.ts` + `packages/opencode/src/session/revert.ts`，靠消息 parts 里的 hash 记台账；
   - v2（开发中）：`packages/core/src/snapshot.ts` + `packages/core/src/session/revert.ts`，快照 hash 直接存在消息 `snapshot.{start,end,files}` 上，DB 以 `seq` 排队，`stage / clear / commit` 三段式。
6. 设计上最值得借鉴的三点：**"整树快照 + 水位线"而不是逆操作日志**、**先恢复 head 再回滚目标区间（让多次 undo 可叠加）**、**服务端只管状态、输入框回填由客户端做**。
7. 最需要避免的三点：**失败只写日志不报错**、**恢复时不做冲突检测（会覆盖用户/IDE 的外部改动）**、**工作树共享一个影子索引带来的跨目录串扰**。
8. **没有 git 就没有文件回退**：非 git 项目（或 `snapshot: false`）下 `/undo` 仍然能执行，但只回退对话、文件一个字节都不动，而且**不报错、不提示**；web 端唯一的提示在 Review 面板，不在 undo 流程里。详见 §11.1。

---

## 1. 概念模型

### 1.1 三个对象

| 对象 | 位置 | 作用 |
| --- | --- | --- |
| 影子 git 仓库 | `<Global.Path.data>/snapshot/<projectID>/<hash(worktree)>` | 存文件内容与 tree 对象，供"回到某个时刻" |
| `patch` part | assistant 消息的 part 列表 | 记录"某个 step 从 tree `hash` 开始，改了 `files`" |
| `session.revert` | 会话元数据 | 当前回退水位线 + 撤销前快照 + 供 UI 展示的 diff |

### 1.2 数据结构定义

`session.revert`（`packages/opencode/src/session/session.ts:211-216`）：

```ts
const Revert = Schema.Struct({
  messageID: MessageID,                 // 水位线：>= 它的消息被视为"已回退"
  partID: optionalOmitUndefined(PartID),// 可选：消息内部 part 级水位线
  snapshot: optionalOmitUndefined(Schema.String), // 撤销前的 head tree，redo 用
  diff: optionalOmitUndefined(Schema.String),     // 原始 git diff 文本，TUI 解析展示
})
```

`patch` / `snapshot` part（`packages/schema/src/session-v1.ts:87-100`）：

```ts
export const SnapshotPart = Schema.Struct({
  ...partBase, type: Schema.Literal("snapshot"), snapshot: Schema.String,
})
export const PatchPart = Schema.Struct({
  ...partBase, type: Schema.Literal("patch"),
  hash: Schema.String,          // 该 step 开始时的 tree
  files: Schema.Array(Schema.String), // 该 step 改动的文件（v1 是绝对路径）
})
```

`step-start` / `step-finish` 的 `snapshot` 字段（同文件 `:233-257`）：分别记录 step 开始/结束时的 tree，用于事后算"某条消息的完整 diff"。

`FileDiff`（`packages/schema/src/file-diff.ts:5-11`）：

```ts
{ file?, patch?, additions, deletions, status?: "added"|"deleted"|"modified" }
```

### 1.3 一个关键前提：消息 ID 是单调递增的

`packages/opencode/src/session/schema.ts:10` 起，消息/part ID 形如 `msg_<12位十六进制时间><随机>`（`packages/opencode/src/id/id.ts:51-70`，时间戳左移 12 位再追加计数器）。
因此 **`id` 的字典序 = 时间序**，整套 v1 实现直接用 `msg.info.id >= rev.messageID` 做区间判断，不需要额外序号。v2 改成了数据库 `seq` 列（见 §8），语义相同但更显式。

---

## 2. 快照子系统（v1，`packages/opencode/src/snapshot/index.ts`）

对外接口（`:36-45`）：`init / cleanup / track / patch / restore / revert / diff / diffFull`。

### 2.1 影子仓库的定位与初始化

```ts
gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)) // :71
```

- 位置：`<Global.Path.data>/snapshot/<project.id>/<worktree 路径 hash>`（`Global.Path.data` 即 `<xdgData>/opencode`，`packages/core/src/global.ts:9-12`），**按 worktree 复用**，不污染项目自带 `.git`。
- 所有 git 调用都带 `--git-dir <影子> --work-tree <worktree>`（`:75`）。
- 全局参数（`:25-27`）：`core.longpaths=true`、`core.symlinks=true`、`core.autocrlf=false`、`core.quotepath=false`，避免 Windows 路径/换行/非 ASCII 路径问题。
- 首次 `track()` 时 `git init` 并写入一套面向大仓库的配置（`:324-338`）：`feature.manyFiles`、`index.version=4`、`index.threads`、`core.untrackedCache`、`core.fsmonitor=false`。
- **`seed()`（`:198-233`）是性能关键**：把真实仓库的 `objects` 目录写成影子仓库的 `objects/info/alternates`（含源仓库自己的 alternates 链），并直接复制源仓库 `index`。这样已有 blob 不必重新 hash；注释里给了动机——chromium 级 checkout 首次 `git add --all` 要几分钟。

### 2.2 抓取文件：`add()` 的筛选策略

`add()`（`:235-298`）不是 `git add -A`，而是一条"精确候选集"管线：

1. `sync()`：把真实仓库的 `info/exclude` 内容拼上"黑名单路径"，写入影子仓库的 `info/exclude`（`:182-193`）。
2. 并行取两组候选（`:239-247`）：
   - `git diff-files --name-only -z -- .`（已跟踪但被改动）；
   - `git ls-files --full-name --others --exclude-standard -z -- .`（未跟踪新文件）。
   - 注意 `cwd = state.directory`、pathspec 是 `.`：**只覆盖当前会话目录之下的范围**（会话目录可以是 worktree 子目录）。
3. `ignore()`（`:102-130`）：用**真实仓库**执行 `git check-ignore --no-index --stdin -z`，把项目 `.gitignore` 命中的路径剔除；对已进入影子索引的路径执行 `git rm --cached`（`:132-144`）。
4. 大文件：对未跟踪文件 `stat`，超过 **2 MiB**（`:24`）的排除并写进 exclude 黑名单（`:277-297`）。
5. 最后 `git add --all --sparse --pathspec-from-file=- --pathspec-file-nul`，只 stage 允许的路径（`:146-160`）。

`--sparse`、`--pathspec-file-nul`、`:(top,literal)`（`:78-79`）这些细节都是为了：路径里有空格/冒号/中文、仓库是 sparse-checkout 时也能稳定工作。

### 2.3 记录 / 取 diff / 恢复

- `track()`（`:318-347`）：`add()` 后 `git write-tree` → **返回 tree hash，没有 commit**。这就是"快照"。
- `patch(hash)`（`:349-380`）：`add()` 后 `git diff --cached --name-only <hash>`，得到该 step 触碰的绝对路径列表，返回 `{ hash, files }`。
- `restore(snapshot)`（`:382-406`）：`git read-tree <tree>` + `git checkout-index -a -f`，**整树恢复**。注意：只覆盖树里有的文件，**快照之后新建、不在树里的文件不会被删除**。
- `revert(patches)`（`:408-524`）：按文件粒度回滚，见 §4.4。
- `diff(hash)`（`:526-544`）：`git diff --cached <hash>`，返回原始 diff 文本（给 `revert.diff`）。
- `diffFull(from,to)`（`:546-759`）：`--name-status` + `--numstat` 得到每文件增删行数，再用 `git cat-file --batch` 一次性批量取 before/after 内容，最后用 `diff` 库生成**全上下文** patch（`context: MAX_SAFE_INTEGER`），产出 `FileDiff[]`；`cat-file` 失败时降级为逐文件 `git show`。

### 2.4 启用条件、清理与并发

- `enabled()`（`:167-170`）：`project.vcs === "git"` 且配置 `snapshot !== false`（配置项 `snapshot`，`packages/core/src/v1/config/config.ts:52`，文案 "Enable or disable snapshot tracking… Defaults to true"）。非 git 项目、关闭快照时 `track()` 返回 `undefined`，整条链路自动退化为"只回退对话"。
- `cleanup()`（`:300-316`）：`git gc --prune=7.days`；服务启动 1 分钟后开始、之后**每小时**跑一次（`:761-766`）。即"快照最多留 7 天"。
- 并发：`locks: Map<string, Semaphore>`，**按 gitdir 串行化**所有读改写操作（`:55-64, :165`）。这是纯进程内锁，多实例/多进程共享同一 worktree 时不互斥。
- 调试：`opencode debug snapshot track|patch <hash>|diff <hash>`（`packages/opencode/src/cli/cmd/debug/snapshot.ts`）。

---

## 3. 快照是在什么时候打的（`packages/opencode/src/session/processor.ts`）

### 3.1 三个时机

| 时机 | 代码 | 行为 |
| --- | --- | --- |
| 处理器创建（LLM 流开始前） | `:110-128` | `initialSnapshot = snapshot.track()`，预捕获 |
| `step-start` 事件 | `:676-691` | 若尚无 `ctx.snapshot` 则补捕一次；写入 `step-start` part（带 `snapshot`） |
| `step-finish` 事件 | `:693-743` | `track()` 得到 `completedSnapshot`，写 `step-finish` part；再 `patch(ctx.snapshot)`，若 `files.length > 0` 追加一个 `patch` part，最后 `ctx.snapshot = undefined` |

为什么要在创建时预捕获？源码注释写得很直白（`:111-113`）：AI SDK 可能**先内部执行工具、后发 `step-start`**，若只在事件里捕获就会漏掉改动。仓库里还留了一个复现测试 `packages/opencode/test/session/snapshot-tool-race.test.ts`：mock LLM 瞬时返回 tool call 时，before/after 两个 tree 相同，导致 diff 为空（注释 `:1-13`）。

### 3.2 时序

```text
create(processor)                         # 每条 assistant 消息创建一次
  └─ track() ──────────────────────────────► T0（预捕获，早于 LLM 流）
step-start
  └─ ctx.snapshot 已由 create 设为 T0 → 直接沿用
  └─ part{type:"step-start", snapshot:T0}
  ── LLM 输出 / 工具执行（写文件）──
step-finish
  └─ completed = track() ─────────────────► T1, part{type:"step-finish", snapshot:T1}
  └─ patch(T0) = { hash:T0, files:[本 step 改动] } ─► part{type:"patch", hash:T0, files}
  └─ ctx.snapshot = undefined
（同一消息的下一个 step）
step-start
  └─ ctx.snapshot 不存在 → track() ───────► T2（首 step 之前才预捕获，后续 step 在此捕获）
  ...
```

`patch.hash` 永远是**该 step 开始前**的 tree；一个 assistant 消息里有 N 个 step，就有 N 个 `patch` part。

一个 assistant 消息可能有多组 `step-start/step-finish/patch`（多步 agent loop），回退时**全部**参与回滚。

### 3.3 顺带产生的"消息级 diff"

`SessionSummary.computeDiff`（`packages/opencode/src/session/summary.ts:82-100`）在消息区间内取**第一个 `step-start.snapshot`** 作为 `from`、**最后一个 `step-finish.snapshot`** 作为 `to`，调 `snapshot.diffFull`。消息 summarize 后结果写回 `message.info.summary.diffs`，供 `GET /session/:id/diff?messageID=` 使用（`:129-142`）。

---

## 4. Undo：`SessionRevert.revert`（`packages/opencode/src/session/revert.ts:38-88`）

### 4.1 前置校验

```ts
yield* state.assertNotBusy(input.sessionID)   // :39，忙则 SessionBusyError → HTTP 409
```

客户端会在调用前主动 `abort`（见 §7），服务端只做兜底。

### 4.2 计算水位线（`:40-68`）

```ts
for (const msg of all) {
  if (msg.info.role === "user") lastUser = msg.info
  const remaining = []
  for (const part of msg.parts) {
    if (rev) { if (part.type === "patch") patches.push(part); continue }
    if (!rev) {
      if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
        const partID = remaining.some((i) => ["text","tool"].includes(i.type)) ? input.partID : undefined
        rev = { messageID: !partID && lastUser ? lastUser.id : msg.info.id, partID }
      }
      remaining.push(part)
    }
  }
}
if (!rev) return session     // 目标不存在：幂等返回
```

规则归纳：

- 只传 `messageID` 时，在**目标消息的第一个 part** 处触发，此时 `remaining` 为空 ⇒ `partID = undefined`，并使用 `lastUser.id` 作为边界。所以"撤到某条 assistant 消息"实际会**吸附到它的父 user 消息**。
- 传了 `partID` 且该 part 之前已经有 `text`/`tool` part 时，才保留 part 级边界（用于"撤掉某条消息里的后半段步骤"）；否则同样退化为消息级。
- 触发点之后的**所有** `patch` part（含同一条消息里更靠后的 part）收集进 `patches`；触发点之前的 patch **不收集**。

### 4.3 保护 head 快照（最容易忽略的一步）

```ts
rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())   // :70
if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot) // :71
yield* snap.revert(patches)                                        // :72
if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)        // :73
```

- 第一次 undo：`rev.snapshot` = 当前（含所有改动）的 tree，即"撤销前 head"。
- 第 N 次 undo：**沿用旧 `snapshot`**（不覆盖），并**先把工作树整树恢复回 head**，再按新的目标区间回滚。
  ⇒ 多次 undo 天然可叠加，且 redo 永远能一次回到"最初撤销前"。
- 若跳过了 `restore(head)` 这步，同文件被多次修改时第二次 undo 会基于"已回滚的文件"再回滚，结果错乱。仓库测试 `revert-compact.test.ts:552-638` 就是守这个语义：

| 操作 | a.txt |
| --- | --- |
| 初始 \| 三次修改 a1/a2/a3 | a3 |
| undo(第1条) | a0 |
| undo(第2条) | a1 |
| undo(第3条) | a2 |
| unrevert | a3 |

### 4.4 文件回滚算法（`snapshot/index.ts:408-524`）

1. 把 `patches` 摊平成 `ops = [{hash, file, rel}]`，按文件去重（`seen`），**先出现者优先**（即同一文件取"最早的那次改动前状态"）。
2. 相邻文件若 `hash` 相同、且路径互不冲突（前缀/父子目录关系，`clash`，`:445`）则合批，每批最多 100 个：
   - `git checkout <hash> -- <abs paths...>`；
   - 批处理失败 → 退回单文件。
3. 单文件路径 `single()`（`:425-443`）：
   - `git checkout <hash> -- <file>` 成功则结束；
   - 失败则 `git ls-tree <hash> -- <rel>` 判断该文件在快照里是否存在：**存在但 checkout 失败 → 保留现状并记日志；不存在 → `fs.remove(file)`**（正确删除"这一步新建的文件"）。
4. 整个过程包在 gitdir 信号量里，失败基本只 `Effect.logInfo/logWarning`，不抛错（见 §10.2）。

### 4.5 收尾：diff、摘要、事件、落库（`:74-87`）

```ts
const range = all.filter((msg) => msg.info.id >= rev.messageID)
const diffs = yield* summary.computeDiff({ messages: range })       // 被回退区间的净改动
yield* storage.write(["session_diff", input.sessionID], diffs)      // 存一份
yield* events.publish(Session.Event.Diff, { sessionID, diff: diffs })
yield* sessions.setRevert({ sessionID, revert: rev, summary: {
  additions: diffs.reduce(...), deletions: ..., files: diffs.length,
}})
```

- `rev.diff` 是"head → 回滚后"的原始 diff 文本（描述"被撤掉的内容"），给 TUI 卡片用。
- `computeDiff(range)` 用的是历史 part 里的 hash，**不受当前工作树影响**，所以能准确描述"这次回退撤掉了哪些改动"。
- `setRevert`/`clearRevert`（`session.ts:772-786`）本质是 `patch()` 发出 `SessionV1.Event.Updated` 事件（`:732-745`），由 v2 projector 落库（`packages/core/src/session/projector.ts:236`）。v1 代码里看不到直接写库，是这套"事件 + 投影"架构的结果。

---

## 5. Redo：不是逆操作，而是"水位线前移"

服务端**没有 redo 接口**，只有 `unrevert`。redo 的完整语义在客户端拼出来（web 与 TUI 逻辑一致）：

### 5.1 客户端判定（`packages/app/src/pages/session/use-session-commands.tsx:334-364`）

```ts
const revertMessageID = info()?.revert?.messageID
if (!revertMessageID) return                       // 不在回退态，redo 无意义
const next = userMessages().find((x) => x.id > revertMessageID)  // 被回退区间里的第一条 user 消息
if (!next) {
  // 没有更多消息可"前进" → 全量恢复
  await client.session.unrevert({ sessionID })
  prompt.reset()
  return
}
// 否则把水位线移到下一条 user 消息：撤掉区间缩小，R 这一轮重新生效
await client.session.revert({ sessionID, messageID: next.id })
```

TUI 完全同构：`packages/tui/src/routes/session/index.tsx:640-665`（`find(x => x.role === "user" && x.id > messageID)`，找不到就 `unrevert`）。

`packages/app/src/pages/session.tsx:1425-1456` 的 `restoreMutation`（"恢复某一条被回滚的消息"按钮）也是同一招：`next = userMessages().find(item => item.id > id)`，有 next 就 `revert(next)`，没有就 `unrevert`——所以点"恢复第 R 条"实际是把水位线推到 R 的下一条，让 R 这轮先回来。

### 5.2 为什么 `revert(next)` 等价于 redo

因为第 4.3 节的第一性原理：

```text
结果 = restore(head)              // 文件回到"全量最新"
     − revert(patch[水位线..])     // 再撤掉水位线及其之后的所有改动
```

水位线从 `R` 移到 `next`（`next` 是 R 之后的第一条 user 消息）后，被撤掉的范围由 `[R..]` 缩小为 `[next..]`，于是 `[R, next)` 这一轮（R 的提问 + 助手回复）的文件效果重新生效。所以：

- **一次 redo = 水位线右移一格**，重放的是"当前边界那一轮"，不是 next 那一轮；
- **redo 到底 = `unrevert`（整树 restore，一次回到 head）**；
- 服务端不需要保存"逆 patch"，也不需要重放 LLM 输出——**对话内容从未被删**，只是被 UI 过滤。

### 5.3 `unrevert`（`revert.ts:90-98`）

```ts
if (!session.revert) return session
if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)  // 整树恢复
yield* sessions.clearRevert(input.sessionID)                               // 清水位线
```

因为 `restore` 是 `read-tree + checkout-index -a -f`，被回退区间里**被删除的文件会被重新写回**、被修改的文件回到 head 版本。代价是：**回退后用户手动改过的文件、IDE/外部进程写的内容，也会被无差别覆盖**（无冲突检测）。

### 5.4 状态机

| 状态 | `session.revert` | 文件 | 可用操作 |
| --- | --- | --- | --- |
| 正常 | 无 | head | undo（任意可见消息） |
| 已回退到 R | `{messageID:R, snapshot:head, diff}` | head − patch[R..] | undo（更早）、redo（右移）、unrevert、发新消息（→ 提交） |
| 已提交 | 无 | 回退后状态 | 只能对新历史 undo；旧消息已删除 |

---

## 6. 消息的"延迟删除"：`cleanup`

### 6.1 revert 阶段不删消息

`revert` 只写 `session.revert`；`messages()` 仍返回全部消息。UI 侧自行过滤：

- app：`visibleUserMessages()`（`use-session-commands.tsx:100-104`）、timeline `selectVisibleUserMessages`（`pages/session/timeline/model.ts:101-104`）；
- TUI：`messages().filter(x => x.id >= messageID && x.role === "user")` 用于"已回退 N 条"卡片（`routes/session/index.tsx:1124-1140`）。

这是 redo 能工作的前提，也让"回退"在 UI 上表现为"折叠"而不是"删除"。

### 6.2 真正的删除时机（`revert.ts:100-134`）

`cleanup(session)` 的调用点：

| 触发 | 位置 |
| --- | --- |
| 发送新消息 | `packages/opencode/src/session/prompt.ts:1159` |
| 执行 shell 命令 | `prompt.ts:462-464` |
| 手动 compact | `server/.../handlers/session.ts:271-275` |

算法：

- 删除所有 `id > revert.messageID` 的消息，以及 `id === messageID` 的消息（消息级回退时）；
- 若是 part 级回退：保留目标消息，但**从 `partID` 位置起截断 parts**，并逐 part 调 `removePart`；
- 最后 `clearRevert`。

所以"发下一条消息"= **提交回退**，与 git 的 `reset --hard` 提交语义类似：消息真正消失，redo 失效。压缩（compact）前也先 cleanup，避免把已回退的消息重新压进上下文（`test/session/revert-compact.test.ts:99+` 覆盖了"回退后再 compact"）。

### 6.3 与"删除单条消息"接口的关系

`DELETE /session/:id/message/:messageID` 是独立的物理删除（`handlers/session.ts:376-385`），会走 `assertNotBusy`，但**不会**顺手 cleanup 回退状态。两条路径互不感知，属于潜在不一致点（见 §10）。

---

## 7. UI 层如何驱动

### 7.1 TUI（`packages/tui`）

- 键位（`src/config/keybind.ts:146-147, :350-351`）：
  - `messages_undo: <leader>u` → 命令 `session.undo`
  - `messages_redo: <leader>r` → 命令 `session.redo`
  - 另有输入框自己的 `input_undo: ctrl+-,super+z`（与本主题无关，是文本框撤销）。
- 命令实现（`src/routes/session/index.tsx:603-665`）：
  - undo：若会话非 idle 先 `session.abort`；取 `messages().findLast(x => (!revert || x.id < revert) && x.role === "user")`；调 `session.revert`；**把该 user 消息的 text/file part 回填输入框**；`toBottom()`。
  - redo：见 §5.1；`unrevert` 成功后清空输入框。
- 视觉：水位线所在消息处渲染一张卡片 `N message reverted` + 文件 diff 列表（`:1190-1224`），`diff` 文本由 `src/util/revert-diff.ts` 用 `parsePatch` 解析成 `{filename, additions, deletions}`。

### 7.2 Web app（`packages/app`）

- 命令（`use-session-commands.tsx:431-446`）：`session.undo`（有可见 user 消息才可用）、`session.redo`（`!info()?.revert?.messageID` 时禁用）；都注册了 slash（`/undo`、`/redo`）。
- undo（`:306-332`）：若 `session_working` 先 `abort`；`findLast(visible user messages)`；`revert`；`extractPromptFromParts` **回填文字 + 附件**；`setActiveMessage` 把视口移到前一条。
- 乐观更新（`pages/session.tsx:1403-1456`）：先 `roll(sessionID, {messageID})` 本地改状态 + 改输入框，请求失败则 `rollback` 到 `last`；成功后用响应 `merge`。
- composer 里的"已回滚消息"托盘（`composer/session-revert-dock.tsx`）：列出 `id >= revert.messageID` 的 user 消息，每条一个"Restore message"按钮 → §5.1 的 `restoreMutation`（前移水位线）。
- 时间线（`pages/session/timeline/model.ts:101-104`）：`filter(message => message.id < revertMessageID)`，被回退消息整体隐藏。

### 7.3 一个值得注意的分工

服务端**从不**回填输入框。undo 后"输入框恢复成当初的提示词"完全是客户端行为（app 会带 file parts，TUI 只能带 text/file，且没有附件回填接口）。这与本插件 README 中"终端没有输入框回填接口"的现状一致，可直接引用其结论。

---

## 8. v2 实现（`packages/core`，开发中）

v1 的"parts 里散落 patch + 消息靠 ID 排序"在 v2 被重构成了"消息自带快照字段 + DB 序号 + 显式三段式"。

### 8.1 快照仍存于消息上

`packages/schema/src/session-message.ts:163-167`：

```ts
snapshot: Schema.Struct({
  start: Schema.String.pipe(Schema.optional),  // step 开始 tree
  end:   Schema.String.pipe(Schema.optional),  // step 结束 tree
  files: Schema.Array(RelativePath).pipe(Schema.optional), // 本 step 改变的文件（相对路径）
}).pipe(Schema.optional)
```

- 每个 step 开始前 `snapshots.capture()`（`core/src/session/runner/llm.ts:210`）；
- step 结束时再 capture 一次，并用 `snapshot.files({from,to})` 求变更列表，随 `Step.Ended` 事件发出（`llm.ts:311-328`）；
- `message-updater` 把 `start` 写进新建的 assistant 消息（`:196-206`），把 `end/files` 合并进 `step.ended` 处理（`:209-222`）。

即：**不再有独立的 `patch` part，也没有 `step-start/finish` part 的 hash**，信息直接挂在消息上，且路径是相对的（可跨机器）。

### 8.2 v2 快照服务（`packages/core/src/snapshot.ts`）

- 影子仓库路径同样是 `<data>/snapshot/<project.id>/<hash(worktree)>`（`:97`）；
- 用 `snapshots` 配置键（`Config.latest(entries, "snapshots") !== false`，`:125`），区别于 v1 的 `snapshot`；
- `capture()`：`git.tree.capture({ scopes: [当前目录], ignores: 源仓库, maximumUntrackedFileBytes: 2MiB })`（`:128-143`）；
- `files(from,to)` 只看路径，`diff(from,to,paths,context)` 才生成 patch（`:150-175`）；
- `restore(files: Map<相对路径, tree>)`：**按文件选择性恢复**；树里没有该路径则删除文件（`:210-216`，实现在 `git.ts:690-717`，逐文件 `git checkout <tree> -- <file>` / `fs.remove`）；
- `preview(files)`：用临时 index（`GIT_INDEX_FILE`）预演恢复结果，产出 diff，**不动工作树**（`git.ts:638-688`）——这是 v1 没有的能力，正好可用于"恢复前给用户看影响范围"；
- `checkout(tree)`：整树 `read-tree + checkout-index --all --force`（`git.ts:719-727`）。

### 8.3 v2 回退（`packages/core/src/session/revert.ts`）

- `plan({sessionID, messageID})`（`:27-58`）：用 DB `seq` 找到边界，取**边界之后所有 assistant 消息**的 `snapshot.start` 与 `snapshot.files`，构造 `Map<file, tree>`（同一文件先出现者优先）。
- `stage({session, messageID, files?})`（`:60-96`，`files` 可关闭文件恢复）：
  1. `original = session.revert?.snapshot ?? capture()`（同 v1 的"保护 head"）；
  2. 先把上一次回退过的文件（`session.revert.files`）恢复回 `original`；
  3. 再把本次要撤的文件恢复到各自 `start` tree；
  4. `diff(original → 当前)`（仅限本次路径）生成**结构化** `files` 与拼接后的 `diff`；
  5. 发布 `RevertEvent.Staged`（带 `revert`），由 projector 写回 session。
- `clear(session)`（`:98-111`）：把 `revert.files` 里的文件恢复回 `original`，发 `RevertEvent.Cleared`（redo 的 unrevert）。
- `commit(session)`（`:113-121`）：只发 `RevertEvent.Committed`；**删除动作在 projector 里**（`projector.ts:416-455`）：删掉 `seq > boundary.seq` 的消息与输入、清 `revert`、重置 context epoch。

### 8.4 v1 vs v2 对比

| 维度 | v1（`packages/opencode`） | v2（`packages/core`） |
| --- | --- | --- |
| 快照记录位置 | `step-start/finish` part + 独立 `patch` part | assistant 消息 `snapshot.{start,end,files}` |
| 路径 | 绝对路径 | 相对路径 |
| 排序依据 | 消息 ULID 字典序 | DB `seq` 列 |
| 恢复粒度 | 整树 restore + 按 patch 文件 checkout | `Map<path, tree>` 选择性 restore |
| diff | 原始 git diff 文本 + `FileDiff[]` | 结构化 `FileDiff[]`（`{path,status,additions,deletions,patch}`） |
| 预览 | 无 | `snapshot.preview`（临时 index） |
| 提交 | `cleanup()` 顺带删除 | `commit` 事件 → projector 删除 |
| 对外 API | `POST revert/unrevert`（已上线） | `Session.revert.stage/clear/commit`（内部，未接 HTTP） |
| 配置键 | `snapshot` | `snapshots` |

> 结论：v1 是当前实际生效的链路（HTTP handler、SDK、UI 都走它）；v2 是进行中的重构方向，语义一致但修正了 v1 的几个结构性问题（绝对路径、消息外挂 part、无预览）。

---

## 9. HTTP / SDK / 事件契约（v1）

| 方法 | 路径 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- | --- |
| POST | `/session/:id/revert` | `{messageID, partID?}` | `Session.Info` | 400 / 404 / **409 SessionBusyError** |
| POST | `/session/:id/unrevert` | — | `Session.Info` | 400 / 404 / 409 |
| GET | `/session/:id/diff?messageID=` | 消息 ID | `Snapshot.FileDiff[]`（来自消息 `summary.diffs`） | — |

定义位置：`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:369-394`（endpoint）、`:73`（`RevertPayload` = `RevertInput` 去掉 `sessionID`）、handlers `handlers/session.ts:347-358`。
409 的定义：`.../httpapi/errors.ts:116-123`（`httpApiStatus: 409`）。

事件：

- `Session.Event.Diff`：回退后广播被回退区间的 `FileDiff[]`（`revert.ts:77`），前端据此刷新 diff 面板。
- `SessionV1.Event.Updated`：`setRevert/clearRevert/patch` 都通过它更新会话（含 `revert` 字段），由 projector 落库并转发给已连接客户端。
- 持久化：`storage.write(["session_diff", sessionID], diffs)`（`revert.ts:76`）。

SDK 生成物中 `session.revert` / `session.unrevert` 两方法即对应上表（`packages/sdk/js/src/gen/*.ts`）。

---

## 10. 一致性、并发与失败模式

### 10.1 并发

- 会话级：`assertNotBusy` 阻止在生成过程中回退；客户端先 `abort` 再请求，避免 409。
- 文件级：影子仓库操作按 gitdir 串行（v1 `Semaphore`、v2 `KeyedMutex`，`git.ts:180-182`），但**仅限单进程**。同一 worktree 被两个 server 实例（比如 TUI + IDE 扩展各起一个）同时操作时，存在索引竞争。
- 快照与工具执行：工具是并行的，快照只在 step 边界捕获；同一 step 内多个工具改同一文件，最终由 `git diff` 汇总，不会丢。

### 10.2 失败处理偏"尽力而为"

- `git` 调用被 `Effect.catch` 包成返回 exitCode（`snapshot/index.ts:93-100`），失败只 `logWarning/logError`；
- `revert()` 单文件失败 → 用 `ls-tree` 判断文件在快照中是否存在：**存在则保留现状（只记日志）；不存在就删除文件**（`:430-443`）。注意判定用的是"查询是否成功"，因此**快照对象被 gc 掉之后，查询失败会被当成"不存在"，进而删掉用户文件**（见 §11）；
- `restore()` 失败只记日志（`:391-403`）；
- 后果：**回退可能"部分成功"且接口仍返回 200**。对用户体验而言是"有的文件回去了、有的没回去"，需要 UI 侧额外校验（opencode 没做）。

### 10.3 会把外部改动一起覆盖

`restore` 是 `checkout-index -a -f`，`revert` 是 `checkout <tree> -- <file>`，都**不做内容比对**。undo 之后用户手改过文件、或编辑器/另一个 agent 改过文件，redo 时会被直接覆盖。v2 的 `preview` 提供了做冲突提示的基础，但 `stage` 目前也没接。

### 10.4 影子索引是共享的（v1 特有）

影子仓库按 **worktree** 建，`add()` 却按**会话目录**（`state.directory`）范围 stage。索引是所有会话共用的：

- 好处：同一 worktree 下多会话共享 blob，省空间；
- 坏处：`write-tree` 会把**整个索引**（含其他目录里更早 stage 的内容）写成树。undo 走的是按文件 `checkout`（只碰 `patch.files`），一般不外溢；但 redo 的 `unrevert` 走**整树 `restore()`**，会把索引里其他目录的文件一起恢复成它们最后一次被 stage 的版本。也就是说跨目录串扰主要发生在 **unrevert** 上。
- v2 用 `restore(Map<path, tree>)` 按文件恢复，并在 `capture` 时只 refresh 当前 scope，风险显著降低。

### 10.5 快照 ≠ 系统快照

只覆盖"当前目录下、未被 gitignore、单文件 ≤ 2 MiB、在快照时刻存在"的文件：

- `bash` 工具在目录外写的文件、`node_modules`/构建产物、>2 MiB 的新文件、符号链接指向的外部路径，都不会被回滚；
- 数据库、网络请求、`git commit` 本身、子模块内部改动不在范围内；
- 一个容易忽略的细节：`revert()` 里 `ls-tree` 查不到就 `fs.remove`，所以"step 里新建的文件"能被正确删掉；但"step 里新建的 >2 MiB 文件"不会进 patch，因此也不会被删（表面看是"回退成功"，实际残留）。

---

## 11. 限制清单（v1 实际行为）

| 场景 | 结果 | 依据 |
| --- | --- | --- |
| 非 git 项目 | 只能回退对话，文件不动 | `snapshot/index.ts:167-170`，详见 §11.1 |
| `snapshot: false` | 同上 | 同上 |
| 快照超过 7 天 | `gc --prune=7.days` 已清掉对象；`checkout` 与随后的 `ls-tree` 都失败 → 按"快照中不存在"处理 → **删除该文件**（数据风险） | `:23, :300-316, :430-443` |
| 文件被 gitignore | 不进快照、不回滚 | `:102-130` |
| 新增文件 > 2 MiB | 不进快照；回滚不会删除它 | `:277-297` |
| undo 之后手改文件 | redo 覆盖手改 | §10.3 |
| 回退后发新消息 | 消息物理删除，redo 永久失效 | §6.2 |
| part 级回退 | 仅当目标 part 之前有 text/tool part 才生效，否则退化为消息级 | §4.2 |
| 同一 worktree 多会话 | 可能互相影响（共享索引） | §10.4 |
| 服务重启后 | 快照与 `revert` 均在磁盘/DB，仍可 redo | 设计如此 |

### 11.1 没有 git 初始化时，undo / redo 到底发生了什么

#### 触发条件

- 项目目录（向上查找）没有 `.git` → `project.vcs` 不是 git（`packages/core/src/project.ts:112`，找不到 repo 时 `vcs: undefined`）；
- 或者配置 `snapshot: false`（`packages/core/src/v1/config/config.ts:52`；配置说明原文就是 *"When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes"*）。

两者都会让 `Snapshot.enabled()` 返回 false（`packages/opencode/src/snapshot/index.ts:167-170`），整条快照链路静默关闭。

#### 链路逐级退化

| 环节 | 代码 | 非 git 时的结果 |
| --- | --- | --- |
| 影子仓库目录 | `snapshot/index.ts:71` | 不创建 |
| `track()` | `snapshot/index.ts:318-321` | 直接 `return`（undefined），连 `git init` 都不跑 |
| `add()` 抓取文件 | `snapshot/index.ts:235-298` | 不执行 |
| 处理器预捕获 | `session/processor.ts:114` | `initialSnapshot` = undefined |
| `step-start/finish` 快照字段 | `session/processor.ts:676-743` | 不写 hash |
| `patch` part | `session/processor.ts:730` | 不写（`if (ctx.snapshot)` 为假） |
| undo 的文件回滚 | `session/revert.ts:70-72` | `rev.snapshot` = undefined → 不 `restore`；`patches` 为空 → 不 `revert` |
| undo 的 `rev.diff` | `session/revert.ts:73` | 不写 → UI 没有"受影响文件"列表 |
| 回退区间 diff | `session/summary.ts:88-100` | 找不到 `step-start/finish.snapshot` → 返回 `[]` |
| redo（`unrevert`） | `session/revert.ts:95` | `session.revert.snapshot` 不存在 → 不 `restore`，只 `clearRevert` |

结果：undo / redo 退化成**纯消息水位线**操作。

- **undo**：`session.revert` 打上标记，UI 过滤隐藏该区间；输入框回填原文（`packages/tui/src/routes/session/index.tsx:620-640`、`packages/app/src/pages/session/use-session-commands.tsx:306-332`）。
- **redo**：水位线前移，或 `unrevert` 清标记让消息重新可见。
- **文件**：从头到尾没人碰，也没有任何报错或警告——`revert()` 的 `patches` 为空，循环体不执行，接口照常 200。

#### 用户实际看到什么

| 界面 | 表现 |
| --- | --- |
| TUI | `/undo` 正常执行（abort → revert → 回填 prompt），但回退卡片里没有文件 diff 列表（`revert()!.diffFiles` 为空），**没有任何"文件没回退"的提示** |
| Web | 同样静默。唯一的提示在 **Review / Changes 面板**：`"No Git version control detected, changes are not displayed"`（`session.review.noVcs`）+ "Create a Git repository" 按钮（`packages/app/src/pages/session.tsx:836-845`）——它不在 undo 流程里，撤销时用户看不到 |
| 文档 | 见下节，两处都写了"会恢复文件改动"，但没写前提 |

#### 怎么才能切回"有文件回退"

1. 点 Review 面板的 "Create a Git repository" → `project.initGit`（`packages/opencode/src/project/project.ts:366-375`，实际就是 `git init --quiet`）；
2. 若 vcs / worktree 变了，handler 会 `markInstanceForReload`（`.../httpapi/handlers/project.ts:22-32`），新实例才带 git vcs，**之后的 step** 才开始产生快照；之前已经发生的改动没有历史 tree，撤不回来。

注意：手动在终端里 `git init` 不会触发这个 reload——实例的 `project.vcs` 在加载时确定并缓存（`packages/opencode/src/project/instance-store.ts:50-65`），要重开目录或重启实例才生效。

#### 文档缺口（为什么看起来像"没 git 也能退文件"）

- `packages/web/src/content/docs/index.mdx` 的 "Undo changes"：*"OpenCode will now revert the changes"*；
- `packages/web/src/content/docs/tui.mdx` 的 `redo`：*"Any file changes will also be restored"*。

两处都**没有**"需要 git 仓库 / `snapshot` 未关闭"这个前提，README 层也没有。所以用户在没有 git 的目录里 undo，会以为文件也回去了。

#### 对本插件的意义

- **DSH Rewind 没有这个限制**：它不依赖 git（`src/files.mjs` 自己抓文件，普通目录排除 `.git` / `node_modules`，见 `docs/usage.zh.md:36`），非 git 目录同样能恢复文件。这是与 opencode 的明确差异，值得写进 README / 对比文档。
- 反过来，如果新 TUI 插件想对齐 opencode 的"静默只回对话"，至少要在确认框里写明"此目录没有文件备份，仅撤回对话"——opencode 的静默是它最容易被误认为 bug 的行为之一。

---

## 12. 对 DSH Rewind（本插件）的启示

### 12.1 可直接借鉴

1. **"整树快照 + 水位线"模型**：不记逆操作，只记"某时刻的树"，回退 = 边界移动 + 快照恢复。这让"回退到任意一条历史消息""连续多次回退""一次 redo 回到底"都变成同一套逻辑，状态机极小。
2. **先恢复 head 再回滚目标区间**（§4.3）：多次 undo 叠加正确性的关键；对应本插件"撤销撤回"要能一次回到最初状态。
3. **redo 用"边界前移 + unrevert"两段式**，而不是反向 patch，避免逆操作日志的复杂度和漂移。
4. **快照挂在 step/消息粒度上**，回退时按消息区间聚合，而不是按工具调用；天然对齐"对话回退"的语义。
5. **延迟删除 + 提交点**：回退阶段只标记，发新消息才真正删。用户误操作可恢复，代价是要显式定义"提交"时机（本插件 README 里"回退对话与已记录文件，再按需撤销回退"就是同一模型）。
6. **预捕获 + 每 step 捕获**（§3.1）：AI SDK 可能在事件前执行工具；本插件若在宿主里挂 hook，也要注意"先执行后通知"的时序。
7. **`alternates` + 复用源 index**（§2.1）：大仓库首次抓取的最大性能优化，值得在自建快照仓库时照抄。
8. **`preview`（临时 index 预演）**：恢复前算"将要发生的改动"，正好支撑本插件"回退前显示实际文件覆盖范围 + 冲突检测"的卖点（opencode v2 有，v1 没有）。

### 12.2 需要明确规避

| opencode 的做法 | 风险 | 本插件应做 |
| --- | --- | --- |
| git 失败只 log，接口照样 200 | 部分回退不可见 | 返回逐文件结果/错误，UI 明确标注"部分失败" |
| restore 无冲突检测 | 覆盖用户外部改动 | 已有设计：恢复前比对 hash/mtime，冲突项单独提示 |
| 影子索引按 worktree 共享 | 跨目录串扰 | 按"项目 + 目录 scoped"隔离索引，或只用按文件 restore |
| 物理删除前无二次确认 | 误提交不可逆 | 发新消息时给出"将丢弃 N 条已回退消息"的确认或可撤销窗口 |
| 2 MiB / gitignore 静默跳过 | 用户以为恢复了其实没恢复 | 在确认框里列"未覆盖"清单 |
| 快照被清理后 checkout 失败即删文件 | **误删用户文件** | 先确认对象存在；缺失时跳过并明确报错，绝不默认"文件不存在于快照" |
| 无 redo 深度限制 | 快照膨胀 | 保留策略（本插件已有自动清理）+ 明确保留期提示 |
| 非 git 项目静默退化为"只回对话"（§11.1） | 用户以为文件也回去了 | 确认框写明"此目录无文件备份，仅撤回对话"，并给出修复入口 |

### 12.3 与本插件概念的映射

| opencode | DSH Rewind |
| --- | --- |
| `snapshot.track()`（影子 git tree） | 检查点 checkpoint |
| `patch` part（step 改了哪些文件） | 每条消息的文件影响记录 |
| `session.revert`（水位线 + head snapshot） | 撤回状态（含"撤销撤回"基线） |
| `revert(messageID)` | 回退到某条消息之前 |
| `unrevert` | 撤销撤回 |
| `cleanup`（发消息时提交） | 新消息提交回退 / 清理 |
| `preview`（v2） | 回退前影响范围 + 冲突检查 |

---

## 13. 关键代码索引

| 主题 | 路径 |
| --- | --- |
| 快照服务（v1） | `packages/opencode/src/snapshot/index.ts` |
| 回退服务（v1） | `packages/opencode/src/session/revert.ts` |
| 会话元数据 / `revert` 字段 | `packages/opencode/src/session/session.ts:211-216, :732-786` |
| 快照捕获时机 | `packages/opencode/src/session/processor.ts:110-128, :676-743` |
| 消息级 diff 汇总 | `packages/opencode/src/session/summary.ts:82-142` |
| cleanup 调用点 | `packages/opencode/src/session/prompt.ts:462-464, :1159`；`handlers/session.ts:271-275` |
| HTTP 契约 | `.../httpapi/groups/session.ts:369-394`；`handlers/session.ts:347-358` |
| part schema | `packages/schema/src/session-v1.ts:87-100, :233-257` |
| FileDiff schema | `packages/schema/src/file-diff.ts` |
| TUI 命令/卡片 | `packages/tui/src/routes/session/index.tsx:603-665, :1119-1140, :1190-1224`；`src/config/keybind.ts:146-147, :350-351` |
| Web 命令/托盘 | `packages/app/src/pages/session/use-session-commands.tsx:306-364, :431-446`；`pages/session.tsx:1403-1477`；`composer/session-revert-dock.tsx` |
| v2 快照/回退 | `packages/core/src/snapshot.ts`；`packages/core/src/session/revert.ts`；`packages/core/src/git.ts:429-727` |
| v2 事件投影 | `packages/core/src/session/projector.ts:397-455`；`message-updater.ts:186-222` |
| 测试 | `packages/opencode/test/session/revert-compact.test.ts`（顺序回退/同文件回退/cleanup 语义）；`test/session/snapshot-tool-race.test.ts`（快照竞态） |
| 非 git 判定与降级 | `packages/core/src/project.ts:112`（vcs 探测）；`packages/opencode/src/snapshot/index.ts:167-170`（`enabled()`） |
| 实例 vcs 缓存与重载 | `packages/opencode/src/project/instance-store.ts:50-65`；`.../httpapi/handlers/project.ts:22-32`（`initGit` → `markInstanceForReload`） |
| 调试命令 | `packages/opencode/src/cli/cmd/debug/snapshot.ts` |

### 13.1 自己动手验证

```bash
# 1) 看当前快照
opencode debug snapshot track
# 2) 改点文件后再 track，对比两次 hash
opencode debug snapshot diff <oldHash>
# 3) 只跑回退相关测试
bun test packages/opencode/test/session/revert-compact.test.ts
bun test packages/opencode/test/session/snapshot-tool-race.test.ts
```

观察点：`<Global.Path.data>/snapshot/<projectID>/<hash>/` 下只有 `objects/`、`index`、`info/exclude`，`git log` 为空——印证"只有 tree、没有 commit"的设计。

---

## 14. 一句话总评

opencode 的 undo/redo 本质是**"内容寻址快照 + 会话水位线 + 延迟提交"**：undo 是水位线后移并回滚区间文件，redo 是水位线前移或整树恢复，真正的删除发生在下一次对话开始。它用极小的状态机换来了任意粒度、可叠加、可跨重启的回退能力，代价是"尽力而为"的错误处理、缺失的冲突检测，以及 v1 共享影子索引带来的边界问题。对 DSH Rewind 而言，模型值得照搬，工程细节（失败可见性、冲突检查、隔离粒度）需要加强。
