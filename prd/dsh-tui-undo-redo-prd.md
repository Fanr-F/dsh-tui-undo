# dsh-tui Undo / Redo PRD（插件版，不改 dsh-tui）

> 版本：v5（v5 修订见 §21：真机验证后，"把事件移出日志"改为"表面替换"，D5/D6 作废）
> 前置材料：[`opencode-undo-redo.md`](./opencode-undo-redo.md)
> 定位：以插件形态实现 undo / redo，**不修改 dsh-tui 与 DSH 核心的源码**。
> 路线：沿用 opencode v2 的**快照与回退语义**（消息快照、`seq` 边界、`stage / clear / commit`、选择式恢复），但把"可见性"从"UI 过滤"换成"**把事件移出会话日志**"。
> 代价：redo 依赖插件侧的副本；这是不改宿主的必然结果。

---

## 0. 决策记录

| ID | 决策 | 结论 |
| --- | --- | --- |
| D1 | 落地形态 | 纯插件（dsh 插件 + 可选 web client），不改 dsh-tui / DSH 核心 |
| D2 | 快照存储 | 影子 git 仓库（`~/.dsh/rewind/<workspace-hash>/repo.git`），只写 tree |
| D3 | 快照挂载 | 每条 assistant 消息/步骤带 `snapshot.{start,end,files}`（相对路径） |
| D4 | 边界 | 会话事件 `seq` |
| D5 | 可见性 | **事件移出日志**：undo 时把 `seq >= 边界` 的事件剪到 side store，UI 自然不显示 |
| D6 | redo | 从 side store 取回事件写回会话；`clear` = 整树回 head + 写回全部 |
| D7 | commit | 发消息 / shell / compact 时删除 side store 副本，redo 失效 |
| D8 | 与 `/rewind` | 并存、互斥：执行 `/rewind` 前先 commit |

被否决：v2 原版的"保留消息 + UI 过滤"。原因是插件拿不到 dsh-tui 的行过滤入口（`Chat.tsx` 的 `rows` 只来自内部 channel）。

### 0.1 方案摘要

**一句话**：文件用影子 git 的快照恢复；对话用"把事件剪出日志"实现不可见；redo 把事件写回；commit 丢掉副本。

```text
undo(target)
  ├─ 恢复文件：restore(head) − 边界之后的 step 快照
  ├─ 把 seq >= target.seq 的事件剪到 side store
  └─ 记 revert { messageID, seq, head tree, files }

redo()
  ├─ 边界之后还有用户消息 → stage(next)：边界前移，写回一段事件
  └─ 没有了 → clear()：整树回 head，写回全部事件

发消息 / shell / compact
  └─ commit：删除 side store 副本，redo 失效
```

**存储布局**

```text
~/.dsh/rewind/<workspace-hash>/
  repo.git/                       影子仓库（只有 tree）
  sessions/<session-hash>.json    revert / 快照索引
  backups/<session-hash>/<id>.json 被剪掉的事件
  locks/
```

**不改宿主的代价**：redo 依赖副本；日志重建依赖 `Session.fromRestore` + `flush`（现有插件已验证，非公开）；提交时机需要插件能赶在上下文组装前。

**下一步**：M1 快照服务（影子仓库 + capture/files/diff/restore），不依赖任何宿主特性。

---

## 1. 目标与非目标

### 1.1 目标

1. undo 到任意一条用户消息：**屏幕上立刻看不到该轮及之后内容**，文件回到该轮执行前。
2. redo：把被剪掉的轮次写回，文件回到撤销前。
3. 连续 undo / redo 可叠加，文件由 `head − 剩余区间` 重算。
4. 回退前可见影响范围；失败逐文件上报。
5. 只依赖 dsh 插件公开能力（外加现有插件已验证的日志重建用法）。

### 1.2 非目标

- 不撤销 `git commit`、不回滚 git 历史。
- 不回滚外部副作用（网络、数据库、目录外文件）。
- 不做跨会话全局撤销栈。
- 不覆盖：`.gitignore` 忽略项、`node_modules`、>2 MiB 新增文件、符号链接外部目标；必须列"未覆盖"。
- 不改 `/rewind` 的 fork 语义。

---

## 2. 模型

### 2.1 三个对象

| 对象 | 位置 | 作用 |
| --- | --- | --- |
| 影子 git 仓库 | `~/.dsh/rewind/<project>/<hash(worktree)>/repo.git` | tree 对象与文件内容 |
| 消息快照 | assistant 消息/步骤的 `snapshot.{start,end,files}` | 该 step 的起止 tree 与改动文件 |
| `revert` | 会话状态（插件侧） | `{ messageID, seq, snapshot(head tree), files }` |

### 2.2 被剪掉的事件：ConversationBackup

```ts
interface ConversationBackup {
  id: string
  sessionId: string
  cutSeq: number          // 从哪个 seq 开始被剪掉
  events: unknown[]       // 原样事件，seq 保持原值
  header: unknown         // 会话头（cwd/model/inheritedEventCount）
  checksum: string
  createdAt: number
}
```

### 2.3 第一性原理

```text
文件 = restore(headTree) − 回滚(边界之后每个 step 的 start tree)
对话 = 日志中 seq < 边界 的事件 + side store 中的副本
```

undo 后移边界（剪事件），redo 前移边界（写回事件），`clear` 回到 head 并写回全部。

### 2.4 不变量

1. **先写副本，再剪日志**；顺序反了，崩溃即丢数据。
2. `original` 只取一次：`revert?.snapshot ?? capture()`。
3. 每次 stage 先把上一次 revert 的文件恢复回 `original`，再应用本次目标（多次 undo 可叠加）。
4. 恢复是选择式的：`Map<相对路径, tree>`，路径不在树里才删文件。
5. 快照对象缺失时跳过并报错，绝不当作"文件不存在"删除。
6. `commit` 之前不删除副本；commit 之后 redo 永久失效。

---

## 3. 数据结构

### 3.1 消息快照（插件侧 side table）

```ts
interface StepSnapshot {
  start?: string
  end?: string
  files?: string[]     // 相对路径
}
type SnapshotIndex = Record<number, StepSnapshot>   // key = 消息 seq
```

优先写入会话事件（若允许扩展）；否则存 side table，随会话状态持久化。

### 3.2 会话状态

```ts
interface FileDiff {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

interface RewindState {
  schema: 1
  sessionId: string
  revision: number
  snapshots: SnapshotIndex
  revert?: {
    messageID: string
    seq: number
    snapshot?: string          // head tree
    files: FileDiff[]
  }
  backupId?: string            // 当前被剪掉的那一段
  journal?: Journal
}
```

### 3.3 事件

```ts
type RewindEvent =
  | { type: 'rewind/staged'; sessionId: string; revert: Revert; backupId: string }
  | { type: 'rewind/cleared'; sessionId: string }
  | { type: 'rewind/committed'; sessionId: string; to: string }
```

---

## 4. 快照服务（与 opencode v2 同构）

### 4.1 接口

```ts
capture(scope?): Promise<{ tree: TreeId; uncovered: { file: string; reason: string }[] }>
files(from, to): Promise<string[]>
diff(from, to, paths?, context?): Promise<FileDiff[]>
restore(files: Map<string, TreeId>): Promise<{ restored: string[]; removed: string[]; failed: { file: string; message: string }[] }>
```

实现备注（M1 已落地）：`capture` 除 `tree` 外返回 `uncovered`，把"未覆盖"从隐含约定变成每次采集的显式结果；`restore` 逐文件返回成功/删除/失败，供确认面板直接展示。

### 4.2 影子仓库

- `gitdir = ~/.dsh/rewind/<projectId>/<hash(worktree)>/repo.git`，`work-tree = 工作区`；
- 首次 `seed`：源仓库 `objects` 写 `alternates`（含链）+ 复制 `index`；
- 固定参数：`core.longpaths`、`core.symlinks`、`core.autocrlf=false`、`core.quotepath=false`、`feature.manyFiles`、`index.version=4`、`core.untrackedCache`、`core.fsmonitor=false`；
- `capture()`：以会话目录为 scope；`diff-files` + `ls-files --others` + `check-ignore` 过滤 + 2 MiB 上限 → `write-tree`；
- 非 git 目录：退化为本地 `git init` 的影子仓库（相对 v2 的必要扩展）。

### 4.3 恢复

```ts
restore(new Map([
  ['src/a.ts', startTree],     // 写回该 tree 的版本
  ['src/new.ts', startTree],   // 树里没有 → 删除
]))
```

- 逐文件 `git checkout <tree> -- <rel>`；批量时同 tree、路径不冲突可合批（≤100）；
- 路径必须相对工作区，越界拒绝；
- 逐文件收集结果，不吞错。

### 4.4 预览

临时 index（`GIT_INDEX_FILE`）预演，产出结构化 diff，不动工作树。

---

## 5. 采集时机

| 时机 | 行为 |
| --- | --- |
| assistant 消息创建 | `capture()` → `start`（预捕获） |
| step 开始 | 无 `start` 则补捕 |
| step 结束 | `capture()` → `end`；`files(start,end)` → `files[]` |
| undo 前 | `capture()` → `original`（若尚无 revert） |

预捕获的原因：工具可能"先执行后通知"（分析文档 §3.1）。

---

## 6. 回退服务

### 6.1 事件视图

剪掉的事件不在日志里，所以 plan 必须看"日志 + 副本"：

```ts
timeline = [...session.events, ...backup.events]   // 按 seq 排序
```

### 6.2 plan（求变更文件集）

```ts
plan(timeline, boundarySeq):
  files = Map<relPath, startTree>
  for (row of timeline where type === 'assistant' && seq > boundarySeq)
    if (!row.snapshot?.start) continue
    for (file of row.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, row.snapshot.start)   // 先出现者优先
  return files
```

### 6.3 stage（undo / redo 共用）

```ts
stage({ session, messageID, files = true }):
  timeline = session.events ++ backup.events
  original = state.revert?.snapshot ?? capture()
  next = plan(timeline, seqOf(messageID))

  restore = new Map()
  if (original && state.revert)
    for (f of state.revert.files) restore.set(f.file, original)   // 先回 head
  if (files)
    for ([p, t] of next) restore.set(p, t)                        // 再回滚本次
  if (restore.size) snapshot.restore(restore)

  // 可见性：把 seq >= 新边界的事件移出日志
  backup = writeBackup(timeline.filter(e => e.seq >= boundarySeq))
  rewriteSession(timeline.filter(e => e.seq < boundarySeq))       // 现有 fromRestore + flush

  diff = original ? snapshot.diff(original, capture() ?? original, [...next.keys()]) : []
  state.revert = { messageID, seq: boundarySeq, snapshot: original, files: diff }
  state.backupId = backup.id
  publish('rewind/staged', ...)
```

要点：

- `stage` 同时承担 undo 和 redo；redo 时新边界更靠后，剪掉的事件更少，被恢复的那段自动写回日志；
- 每次都先"上一次回退的文件 → original"，保证多次 undo 可叠加；
- `files = false` 表示只回退对话。

### 6.4 clear（redo 到底）

```ts
clear(session):
  if (!state.revert) return
  restore(new Map(state.revert.files.map(f => [f.file, state.revert.snapshot])))
  rewriteSession(timeline)          // 全部事件写回
  state.revert = undefined; state.backupId = undefined
  publish('rewind/cleared')
```

### 6.5 commit（提交回退）

```ts
commit(session):
  if (!state.revert) return
  deleteBackup(state.backupId)      // 日志已被剪过，消息不在了
  state.revert = undefined; state.backupId = undefined
  publish('rewind/committed', { to: messageID })
```

触发点：发送新消息、执行 shell、手动 compact（在"产生新历史"之前执行）。

---

## 7. 语义

### 7.1 状态机

| 状态 | 日志 | 副本 | 可用操作 |
| --- | --- | --- | --- |
| 正常 | 完整 | 无 | undo |
| 已回退 | 到边界为止 | 有 | undo（更早）、redo、发消息（提交） |
| 已提交 | 到边界为止 | 无 | 只能对新历史 undo |

### 7.2 undo / redo 映射

```text
undo(target):  stage(target)     // 边界后移，事件剪走
redo():        next = 边界之后的第一条用户消息
               next 存在 → stage(next)   // 边界前移，事件写回一段
               否则      → clear()       // 全部写回 + 回 head
```

- 连续 undo：每次更早的消息，`original` 沿用。
- 连续 redo：每次更晚的消息，最后 `clear`。
- 发新消息：先 commit，再投递。

### 7.3 与 v2 原版的差异

| | v2 原版 | 本方案 |
| --- | --- | --- |
| 未提交的消息 | 留在日志，UI 过滤 | 移出日志到 side store |
| plan 数据源 | 会话日志 | 日志 + 副本 |
| 上下文 | 核心按边界排除 | 事件已不在日志，天然排除 |
| commit | 投影器删消息 | 删副本 |

---

## 8. 插件接口与 TUI 交互

### 8.1 命令

| 命令 | 行为 |
| --- | --- |
| `/undo` | 只弹一次 picker；选中目标立即执行（有 git 就同时回退文件和对话，没有 git 只回退对话） |
| `/redo` | 若存在可前移的边界则 `stage(next)`，否则 `clear`；执行前一次确认 |
| `/rewind` | 交给 dsh-tui 原有实现 |

### 8.2 选择面板

```text
回退到哪条消息之前？
> 这条消息的文本
  隐藏 N 轮 · M 条消息
```

选中即回退，不再追问“仅对话/对话+文件”，也不再加确认页。文件是否回退由 git 能力决定：
找不到 `git` 时自动退化为仅对话，并在结果里注明“未找到 git，文件未改动”。

### 8.3 输入框回填

插件在终端没有 composer 写入接口（`tui.mjs` 只能弹对话框），因此：

- 在确认结果里显示"原输入：<截断文本>"；
- 若宿主未来提供回填 seam，再切换成真正回填。

### 8.4 web 端

web client 可作为增强：投影适配器按 `revert.seq` 过滤（其实事件已被剪掉，过滤是冗余的），并提供 `/undo` `/redo` 按钮。

---

## 9. 失败模式

| 场景 | 行为 | 用户可见 |
| --- | --- | --- |
| 剪日志失败 | 不写副本、不改文件 | 明确报错，状态不变 |
| 写副本失败 | 不剪日志 | 报错 |
| 部分文件恢复失败 | 继续其余 | 逐文件列表 |
| 快照对象缺失 | 跳过，不删 | "快照已过期，`a.txt` 未恢复" |
| 外部修改冲突 | 默认跳过 | 冲突列表 + 强制覆盖 |
| working 中 | 拒绝 | "请先停止" |
| 副本丢失/损坏 | 拒绝 redo，保留现状 | "重做记录已损坏" |
| 崩溃 | journal 恢复 | "上次操作未完成：续做 / 回滚" |

---

## 10. 与 `/rewind` 的关系

1. 有 revert 时执行 `/rewind`：先 `commit`，提示"回退会被固化、无法重做"。
2. `/undo` 不 fork，会话 id 不变。
3. fork 出的会话不继承 revert / 副本。
4. `/tree` 只表示会话分支。

---

## 11. 存储、容量与清理

```text
%USERPROFILE%\.dsh\rewind\<workspace-hash>\
  repo.git\
  sessions\<session-hash>.json
  backups\<session-hash>\<cutSeq>-<id>.json
  locks\<workspace-hash>.lock
```

| 项 | 默认值 |
| --- | --- |
| 单副本上限 | 32 MiB（超限拒绝本次 undo） |
| 全局容量 | 2 GiB（硬上限 4 GiB） |
| 保留期 | 30 天 |
| 清理 | 每个被引用 tree 建 `refs/rewind/<id>`，`git gc --prune=7.days` 不误删 |

---

## 12. 并发与崩溃恢复

- 单会话串行；同工作区文件锁。
- 写事务：`journal`（backupId、changes、headTree、目标 seq）→ 写副本 → 剪日志 → 恢复文件 → 落状态 → 清 journal。
- 启动恢复：按 journal 记录的步骤续做或回滚；都失败则只读。
- 多实例：第二实例只读。

---

## 13. 性能

| 场景 | 目标 |
| --- | --- |
| 单次 capture（1 万文件 / 500 MiB） | ≤ 3 s |
| stage（100 文件） | ≤ 2 s |
| 副本写入（1 万条事件） | ≤ 200 ms |
| preview | ≤ 1 s |

---

## 14. 测试

| # | 用例 | 期望 |
| --- | --- | --- |
| T1 | a1→a2→a3，undo×3 | a0 → a1 → a2 |
| T2 | T1 后 redo×3 | a3 |
| T3 | undo 后发消息 | commit，副本删除，redo 失效 |
| T4 | undo 新建文件 | 文件消失 |
| T5 | undo 删除文件 | 恢复 |
| T6 | 二进制 | 字节一致 |
| T7 | 非 git 目录 | 退化仓库；无快照时仅对话 |
| T8 | >2 MiB 新增 | 未覆盖清单 |
| T9 | 外部修改后 redo | 冲突提示 |
| T10 | 剪日志中途 kill | 重启后 journal 恢复一致 |
| T11 | 两会话同工作区 | 第二个拒绝 |
| T12 | 副本损坏 | 拒绝 redo，文件不变 |
| T13 | undo→redo→undo | 幂等 |
| T14 | 与 `/rewind` 混用 | 先 commit |
| T15 | redo 后 seq 重排 | 旧 seq 引用失效，id 不变 |

---

## 15. 里程碑

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| M1 | 快照服务：影子仓库 + capture/files/diff/restore | 完成（`src/snapshot.mjs`、`src/git.mjs`） |
| M2 | 消息快照 side table + 事件视图（日志 + 副本） | 完成（`src/collect.mjs`、`src/timeline.mjs`、`src/store.mjs`） |
| M3 | stage：剪日志 + 写副本 + 恢复文件 | 完成（`src/revert.mjs`，含 undo/redo/clear/commit/preview） |
| M3.5 | 运行时编排：pre-step 采集、assistant 记账、发送前提交 | 完成（`src/runtime.mjs`） |
| M3.6 | 宿主端口（`Session.fromRestore` + `create` + `flush`） | 代码完成、**待真实宿主验证**（`src/host.mjs`，R1） |
| M4 | `/undo` 命令 + picker + 面板 | 完成（`src/commands.mjs`、`src/index.mjs`） |
| M5 | redo / clear + commit + 与 `/rewind` 互斥 | 核心与命令完成；提交时机待真实宿主验证（R2/R3） |
| M6 | 冲突检测、清理、崩溃恢复、性能 | 未开始 |

---

## 16. 开放问题

| ID | 问题 | 倾向 |
| --- | --- | --- |
| Q1 | 日志重建（`Session.fromRestore` + `flush`）是否算稳定接口 | 先用，做能力探测与降级 |
| Q2 | 快照字段能否写进消息事件 | 不能则 side table |
| Q3 | 副本用 JSON 还是二进制打包 | 先 JSON（<32 MiB），后续可换 brotli |
| Q4 | 保留期 30 天 | 待压测 |

---

## 17. 宿主依赖与风险

| # | 依赖 | 风险 | 兜底 |
| --- | --- | --- | --- |
| R1 | `Session.fromRestore` + `ctx.sessions.flush` 重写日志 | 非公开接口，升级可能变 | 启动时探测，失败则禁用文件回退（仅对话） |
| R2 | 插件能挂到"发送消息前"的时机做 commit | 时机不对会让模型看到已回退内容 | 若拿不到，退化为"每次生成前强制 commit"或提示用户 |
| R3 | 插件能拦截 shell / compact | 漏拦则提交点不完整 | 只保证"发消息"这一个提交点，其余提示 |
| R4 | 输入框回填 | 无接口 | 对话框展示原文 |
| R5 | git 可执行文件 | 无 git 则仅对话 | 能力探测 + 明确提示 |

---

## 18. 附录：v2 → 插件版映射

| opencode v2 | 本方案 |
| --- | --- |
| `Snapshot.capture/files/diff/restore` | 同名实现 |
| `message.snapshot.{start,end,files}` | 消息事件字段或 side table |
| `SessionRevert.plan` | `plan(timeline, seq)`（timeline = 日志 + 副本） |
| `SessionRevert.stage` | `stage()`：恢复文件 + 剪日志 + 写副本 |
| `SessionRevert.clear` | `clear()`：写回全部 + 回 head |
| `SessionRevert.commit` | `commit()`：删副本 |
| `RevertEvent.*` | `rewind/*` 事件 |
| projector 删消息 | 剪日志（`fromRestore` + `flush`） |
| UI 过滤 | **不需要**：事件已不在日志 |

---

## 19. 版本沿革

| 版本 | 核心思路 | 为什么放弃 / 保留 |
| --- | --- | --- |
| v1 | 需求草案：目标、非目标、宿主能力矩阵、验收标准 | 缺具体实现路线，保留为背景 |
| v2 | 截断 + 事件副本 + redo 栈 | 与 opencode 偏离较大；redo 语义与 v2 不一致 |
| v3 | 完全照搬 opencode v2：保留消息 + UI 过滤 + stage/clear/commit | 依赖 dsh-tui 行过滤（`Chat.tsx:7202`）与核心上下文排除；插件做不到 |
| **v4（当前）** | **v2 的快照/回退语义 + 把事件移出日志实现可见性** | 不改宿主；代价是 redo 依赖副本（R1/R2） |

关键结论：

1. 渲染过滤只出现在"保留消息"这一种设计里；插件拿不到行数组，所以必须让事件离开日志。
2. `plan()` 因此要读"日志 + 副本"，其余与 v2 一致。
3. 提交点（发消息 / shell / compact）是 redo 的唯一边界，必须赶在上下文组装前。

---

## 20. 实现记录（M1–M3）

| 文件 | 职责 |
| --- | --- |
| `src/git.mjs` | git 调用；**文件重定向代替 stdio 管道**（DSH 沙箱在 Windows 上拒绝为子进程建管道，`spawn EPERM`），顺带解除 `maxBuffer` 上限 |
| `src/snapshot.mjs` | 影子仓库 seed/alternates/config、`capture/files/diff/restore/listTree` |
| `src/collect.mjs` | 每步 `begin(seq)` 预捕获、`end(seq)` 收尾并算 `files[]`、`forget(seq)` |
| `src/timeline.mjs` | `mergeTimeline`、`plan`、`nextBoundary`、`hiddenRange`、`touchedFiles` |
| `src/store.mjs` | 状态与副本的原子读写、副本 checksum、工作区互斥锁 |
| `src/revert.mjs` | `undo/redo/clear/commit/preview/targets`，端口注入，可脱离宿主测试 |
| `src/runtime.mjs` | 宿主无关编排：pre-step 采集、assistant 消息记账、发送前提交、撤销请求 |
| `src/host.mjs` | 宿主端口：`fromRestore` + `create` + `flush`，带宽限期与"事件数必须守恒"校验 |
| `src/commands.mjs` | `/undo` `/redo` 的命令面板：`/undo` 选目标即执行；`/redo` 一次确认 |
| `src/index.mjs` | dsh 插件入口：钩子注册、命令注册、能力不足时降级并告警 |

实现中确认的语义（易误判，已写入测试）：

1. **undo 不删"边界之前创建的文件"**。`plan` 只覆盖边界之后每个 step 的 `files`，若某文件在更早的轮次创建、边界后未再改动，它就保持原样。这既是 opencode v2 的选择式恢复，也是"只回滚这一段"的正确含义。
2. **先写副本、再剪日志**：`stage` 在 `rewrite` 抛错时会删掉刚写的副本并原样返回，文件与状态都不变（有测试覆盖）。
3. ~~**commit 要连带丢弃 `seq >= 边界` 的快照索引**~~：**已被 §21 推翻**——真机上序号不复用，日志也不会被剪，因此不存在串味问题。
4. 测试运行器需 `--test-isolation=none`：默认子进程隔离同样走管道，在沙箱内会 `EPERM`。
5. ~~**提交判据用 `seq >= 边界`，不是 `>`**~~：**已被 §21 推翻**——序号不复用，新消息总是落在边界之后；但保留 `>=` 仍然安全（空洞边界不存在时不会误判）。
6. step 的 `start` 树在内存里传递：pre-step 时还没有 `assistant/message` 的序号，直到该消息事件到来才把 `{start, end, files}` 落到 side table；进程中途重启只会丢这一段的文件归属，不会丢对话。

---

## 21. 宿主验证与 v5 转向（取代 D5 / D6）

**验证方式**：`scripts/verify-host.mjs` 直接加载本机 dsh 0.2.2-rc.1 实际使用的
`@deepseek-ai/dsh-session`（`…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session`），
在真实 `Session` 上跑六个断言，全部通过；结论与 v4 的前提相反。

| # | 断言 | 实测结果 |
| --- | --- | --- |
| Q1 | `Session.create(id, seed, …)` 是否截断活会话 | **不会**。活会话事件数不变；它只返回一个独立对象，且 seed 会额外补一颗 `session/end-seed` |
| Q2 | `surfaceOp: replace` 是否把行从表面移除 | **会**。surface `[1,2,3]` → `[1,4]`，2、3 被替换节点取代 |
| Q3 | 序号是否会复用 | **不会**。`seq` 永远等于日志长度，只增不减 |
| Q4 | 隐藏的行能否被再次 replace 恢复 | **不能**。replace 只能指向"当前在表面上"的节点，隐藏后报 `start seq 2 not found in surface` |
| Q5 | `fromRestore` 是否等价于前缀恢复 | **不等价**。2 颗 seed 恢复成 3 颗（同样补 `end-seed`） |
| Q6 | 隐藏的消息能否以"追加副本"的方式重新可见 | **可以**。追加副本拿到新序号并进入表面，原事件保持隐藏 |

### 21.1 结论

1. **DSH 会话日志严格 append-only**，`seq = 日志长度`；"把事件从日志剪走"在活会话上做不到，
   唯一截断方式是"用前缀 seed 新建会话"= fork（本方案正要避免的）。
2. **可见性由表面控制**：`surface` 是派生模型历史的唯一来源。要让某轮消失，就追加一条
   `developer/message`，带 `surfaceOp: { op: 'replace', startSeq, endSeq }`，且
   `sourceEventSeqs` 必须列全被遮蔽的每一个表面节点。
3. **被隐藏的事件仍在日志里**，序号永远指向同一内容 → 不需要 side store 保存副本，
   `commit` 也退化为"丢弃回退状态"。
4. **redo 只能是"再追加一份"**：隐藏的行无法复活，必须重新 append 副本；副本需要新的
   message id，并保持 tool call 与 tool result 的配对。这是 v5 唯一的难点。

### 21.2 v5 修订后的机制

```text
undo(target):
  ├─ 恢复文件：restore(head) − 边界后的 step 快照          （与 v4 相同）
  ├─ hideFrom(surface, 目标节点 seq)
  │    └─ append developer/message { surfaceOp: replace, sourceEventSeqs: 全量被遮蔽节点 }
  └─ 记 revert { messageID, seq, headTree, files }

redo():
  ├─ 边界之后还有用户消息 → 把这一段事件以副本形式 append（surfaceOp: append）
  └─ 没有了 → clear：把全部被隐藏事件以副本 append 回去

commit():
  └─ 丢弃 revert 状态（隐藏事件仍在日志中，永久保留）
```

`src/surface.mjs` 已按该契约实现：`surfaceNodes` / `hideFrom` / `showCopy` / `turnStep`，
并配一个**按真机规则实现的 FakeSession**（缺 `surfaceOp` 报错、replace 范围必须在表面上、
`sourceEventSeqs` 必须覆盖全部被遮蔽节点）作为契约测试。

### 21.3 对已完成代码的影响

| 模块 | 状态 |
| --- | --- |
| `snapshot.mjs` / `git.mjs` / `collect.mjs` | **不受影响**：文件侧与对话机制无关 |
| `timeline.mjs` 的 `plan` / `nextBoundary` / `hiddenRange` | 逻辑仍成立；`mergeTimeline(日志+副本)` 不再必要（日志本身完整） |
| `store.mjs` 的 backup 读写 / checksum | 保留作审计与副本内容来源，但不再是 redo 的必要条件 |
| `revert.mjs` 的 `stage/clear`（剪日志） | **必须重写**为 `surface.hideFrom` + 副本重放（M7） |
| `host.mjs` 的 `rewrite`（`fromRestore`+`create`+`flush`） | **作废**：真机上它不截断任何东西 |
| `runtime.mjs` | 采集与提交逻辑保留；`event()` 可简化为"日志即时间线" |

### 21.4 新增里程碑

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| M7 | 用 `surface.hideFrom` 重写 `revert.stage/clear`；`host.mjs` 换成表面端口；补 undo→undo→redo 契约测试 | **完成**：`revert.mjs`/`host.mjs` 已重写；`revert`/`runtime`/`host`/`commands` 测试已按 v5 重写（70 项全过） |
| M8 | redo 的消息重放：克隆事件、重生成 message/tool-call id、保证 tool call 与 result 配对 | **完成**：`src/replay.mjs` 在批量重放前重写 message id、tool-call id 与 stream；真机 Q9 验证配对 |
| M9 | 把 `verify-host.mjs` 纳入发布前检查（宿主升级即回归） | 脚本已扩充到 9 条断言，尚未接入 CI |

### 21.5 rc.2 复核（本地源码 `D:\Code\deepseek-harness`，`dsh-v0.2.2-rc.2-166-ge8f7b93a34`）

发布说明里唯一相关的一条是「Session 支持批量追加事件，日志格式不变」。逐条核对源码后确认：
**rc.2 没有增加任何截断/删除/替换日志的能力，v5 结论不变。**

| 检查点 | rc.2 实际情况 |
| --- | --- |
| 批量追加 | 新增重载 `append(inputs: readonly SessionEventInput[])`；`#appendEvents` 仍是"全部校验 → `log.push` → 统一发布"，没有删除路径 |
| `seq` 契约 | `get seq() { return this.log.length }` 未变 |
| 交换活会话 | `SessionStore` 仍无 replace/swap；`create` 对已存在 id 直接抛 `session "…" already exists` |
| 持久化 | `session-persistence-jsonl` 仍是追加；`truncate` 只用于修复撕裂尾巴（`tornTruncateTo`） |
| surface 约束 | `surface.ts:420/424` 仍是 `start/end seq not found in surface`；`sourceEventSeqs` 仍须覆盖全部被遮蔽节点 |

**批量追加对我们的用处**：`src/surface.mjs` 新增 `supportsBatchAppend`（探测 `currentBatchPublication`，只读、无副作用）
与 `showCopies`——M8 的 redo 可以用一次 `append(inputs)` 原子写回整段被隐藏事件，避免"半截恢复"的中间态，
也不会每个事件触发一次 flush。无该能力时自动退化为逐条追加。

另：`packages/core/session/src/surface.ts` 导出了 `foldSurface` / `isSurfaceEvent` / `isReplacementSurfaceEvent`，
后续做 `preview`（不动会话地预演表面折叠）可以直接复用，不必自己实现折叠逻辑。

### 21.6 rc.2 实机校准与 v5 修正（2026-11-12）

装上 `deepseek-ai/dsh@0.2.2-rc.2`（`@deepseek-ai/dsh-session@0.2.2-rc.2`）后，用
`scripts/verify-host.mjs` 复核 7 条旧断言，并新增 Q8：在真实 `Session` 上跑本插件的
`hideFrom` + 批量 `showCopies`，结果 `hide [3,4] -> surface [5]`、`copies [6,7] -> [5,6,7]`，
全部 8 条 PASS。v4 的 `fromRestore + create + flush` 路线确认作废。

对照 `packages/core/session/src/{index,surface,types}.ts` 逐项校准后修正了以下实现偏差：

| # | 问题 | 修正 |
| --- | --- | --- |
| 1 | **redo 会把文件恢复到 undo 前的 head**，包括仍被隐藏的后续轮次 | 恢复计划改为「head 兜底，`plan(新边界)` 覆盖」；文件回退到新边界而不是 head |
| 2 | redo 结束后再 undo，按 `messageID` 会解析到隐藏的原始事件，报「已经不在对话中」 | 目标改为**可见序号**（`targets[].seq`），`preview/undo` 优先用 seq；命令层传 seq |
| 3 | `hiddenRange(timeline, origin)` 把隐藏原件和 copies 一起计数，轮数翻倍 | 计数改为只统计当前 surface 上的事件，并排除 undo 标记 |
| 4 | 清空 redo 时会把隐藏的 copies 再复制一遍，导致对话重复 | 新增 `replayableEvents`：排除可见事件、copy、已有可见 copy 的原件与 undo 标记 |
| 5 | redo 追加的 assistant 副本会触发 `session/event` 记账，把**当前工作区**写进副本序号的快照 | `runtime.event` 只处理有 pre-step 占位的 assistant 消息 |
| 6 | `commitIfSuperseded` 扫描整条日志，隐藏原件/redo 副本会被当成新用户消息 | 只看可见且非 copy 的 user 消息 |
| 7 | undo 标记 id 固定为 `hide-<start>-<end>`，重复回退同一段会撞 id | 每条标记用 `randomUUID()` 生成唯一 id |
| 8 | redo 副本沿用原件 `message.id` / tool-call id，客户端若按 id 建 key 会把两轮折叠 | `src/replay.mjs`：每条消息换新 id，assistant 的 tool-call、stream 与 tool/result 同步重映射 |
| 9 | compaction 改写 surface 后，按旧边界重放会落到错误位置 | undo 记录 `replaceGeneration/contentGeneration`；redo 前不一致就拒绝（“对话已被压缩或改写”） |
| 10 | undo 要连续回答“目标 → 范围 → 确认”，交互过重 | `/undo` 只保留目标 picker，选中即执行；有 git 同时回退文件与对话，无 git 自动仅对话并注明 |

测试：`node --test --test-isolation=none test/*.test.mjs` → **74 pass / 0 fail**；
`node scripts/verify-host.mjs` → **9/9 PASS**（真机 rc.2）。

仍然存在的风险与下一步：

1. redo 副本的 id 已重写（`src/replay.mjs`，真机 Q9），但 dsh-tui 若还有其他按 id 建立的索引，
   仍需在真实 TUI 里跑一次 undo→redo→undo 确认无重复行。
2. 压缩改写 surface 已被 generation 检查拦住（拒绝 redo），但**压缩后如何继续**（重新定位边界、
   或提示用户先 commit）还没有产品化方案。
3. 包根 `dsh-plugin.json` 已按 v0.15 写好，并用 dsh-tui 自带的 `@dsh-std/manifest`
   做了解析与投影校验（`npm run verify:manifest`）；真实 `/plugin install` 准入仍需在 TUI 里跑一次。
4. `workingDirectory` 服务名与 `get(session)` 已核实无误；`tuiDialogs.select/confirm`
   的调用方式与 dsh-tui 0.19 一致。
5. v4 遗留已清理：`store.mjs` 的 backup 读写、`paths.mjs` 的 backup 路径、
   `timeline.mjs` 的 `mergeTimeline/hiddenRange` 及其测试均已删除；`state.backup` 字段不再读取。

### 21.7 打包与安装（v5）

插件现在有两条加载路径：

| 用途 | 文件 | 用法 |
| --- | --- | --- |
| 开发期直接跑源码 | `examples/tui-local.cordis.yml` | `dsh tui --patch ./examples/tui-local.cordis.yml`（插入行用相对路径 `./src/index.mjs`，按 patch 文件所在目录解析） |
| 作为 bundle 安装 | `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` | `dsh plugin --profile <name> add <本目录>`；profile 的 bundles 列表追加 `dsh-tui-undo` |
| dsh-tui 社区准入 | `dsh-plugin.json`（manifest v0.15） | `facets.host.entry = ./src/index.mjs`，`apiVersion = v1alpha1`；声明 `undo`/`redo` 两个命令贡献 |

`cordis.patch.yml` 只有一行 `insert`（id `dsh-tui-undo`，name `dsh-tui-undo`），由 Node 从 profile 解析到已安装包。

`dsh-plugin.json` 的校验直接用 dsh-tui 自带读取器（`@dsh-std/manifest`）：

```text
$ npm run verify:manifest
manifest: dsh.tui-undo@0.1.0
entry:    ./src/index.mjs (lifecycle.dsh/v1alpha1 FacetModule)
commands: dsh.undo, dsh.redo
PASS manifest is valid
```

`test/manifest.test.mjs` 在未安装读取器时自动 skip，装了就会跑同一套解析/投影断言。

实测（临时 `DSH_HOME`，避免污染用户 profile）：

```text
dsh plugin --profile undo-demo add d:\Code\dsh-tui-undo
  → dependencies: dsh-tui-undo <- ../../../..
  → bundles: [@deepseek-ai/dsh-base, dsh-tui-undo]

dsh --profile undo-demo --dump-config
  → # == dsh-tui-undo
    - id: dsh-tui-undo
      name: dsh-tui-undo
```

`require.resolve('dsh-tui-undo', { paths: [profile] })` 解析到本仓库 `src/index.mjs`；
入口导出 `name/apply/install` 正常。

真实 profile 安装（2026-11-12）：已装入 `~/.dsh/profiles/dsh-tui`：

```text
dependencies: "dsh-tui-undo": "link:d:/Code/dsh-tui-undo"
bundles:      [@deepseek-ai/dsh-base, @deepseek-harness-tui/dsh-tui, dsh-tui-undo]
dump-config:  # == dsh-tui-undo / - id: dsh-tui-undo / name: dsh-tui-undo
```

这是 `link:` 安装：改 `src/` 后重启 TUI 即生效，不需要重新安装。

尚未完成：

1. 真实 TUI 交互冒烟（`dsh tui --patch ./examples/tui-local.cordis.yml`）仍需人工跑一次；
   `dsh-plugin.json` 已通过读取器校验，但 dsh-tui 的 `/plugin install` 落盘/准入链路尚未实测。
2. `pnpm` 安装时会用到用户级 store 锁（`%LOCALAPPDATA%\pnpm-store-operation-locks`），
   在 DSH 的 workspace-write 沙箱下需要 `danger-full-access` 才能安装；测试时已授权执行。

