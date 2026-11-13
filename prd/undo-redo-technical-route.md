# undo / redo 技术路线（v6）

> 状态：设计定稿，待实现
> 日期：2026-11-13
> 目标平台：**dsh web 优先**；dsh-tui 暂不作为验收目标
> 参考实现：`D:\Code\dsh-undo-plugin`（MIT，只借鉴机制，不复制代码）

---

## 0. 一句话

**不改宿主、不 fork 会话、不伪造 turn**：每次 undo/redo 都通过
`agent.runMaintenance()` 借一个**真实的 maintenance turn**，在它的
`agent/pre-step` 里把“目标对话快照”重放成新的 `step` 事件，然后
`return { kind: 'reject' }` 阻止模型调用。turn 号由 agent 自己递增，
所有消息都落在合法的 `turn/step` 内，因此**日志可重新加载**。

---

## 1. 目标与非目标

### 1.1 目标

1. `/undo` 回到某条用户消息之前：对话隐藏、文件恢复。
2. `/redo` 逐轮恢复，直至回到 head。
3. **重启 / 切换会话 / web 重新打开后，日志必须通过 v4 格式校验。**
4. 保持同一个 session id，不 fork、不换会话。
5. 崩溃后可恢复：不允许出现“文件已改、日志半截”的状态。

### 1.2 非目标（本阶段）

- 不追求 dsh-tui 的界面回退（TUI 转录层不读 surface，另行处理）。
- 不修改 `@deepseek-ai/dsh-session` / 格式校验器 / token meter。
- 不实现任意系统副作用（外部命令、网页操作）的回退。
- 不替代 dsh-tui 自带的 `/rewind`（fork 式）。

---

## 2. 硬约束（来自 rc.2 真实源码）

### 2.1 surface 只能隐藏，不能“显示”

`packages/core/session/src/types.ts`：

```ts
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

- `replace` 的 `startSeq/endSeq` 必须能在**当前 surface** 找到；
- 被隐藏的事件不可再被 `replace` 引用（`verify-host.mjs` Q4 已实测）；
- 因此 redo **不能**“把旧事件放回 surface”，只能重放副本。

### 2.2 持久化日志的 turn/step 关系校验

`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`：

```js
STEP_EVENT_TYPES = ["system/message", "developer/message", "assistant/attempt"]
// 所有 assistant/message、tool/call、tool/result 也走：
tool(event, data) { ... this.requireStep(event, data) ... }

requireTurn(type)   // turn !== null
requireStep(event)  // turn/step 都非空且 data.turn/step 匹配
turn/start 的 turn 必须等于 nextTurn（严格递增）
```

结论：

- `developer/message`、`assistant/message`、`tool/call`、`tool/result`
  都必须落在**打开的 turn + step** 内；
- 命令执行时通常已经 `turn/end`，直接 append 会写坏日志；
- 回合号归 agent 所有，插件伪造 turn 会与下一次真实 turn 撞号。

### 2.3 为什么 v4 / v5 失败

| 版本 | 做法 | 失败原因 |
| --- | --- | --- |
| v4 | 剪日志 + backup | rc.2 日志 append-only，无截断 API |
| v5 | surface 隐藏 + redo 追加副本 | 副本写在 turn 外，reload 报 `stored log is corrupt` |

---

## 3. 可行机制：maintenance turn replay

参考实现 `D:\Code\dsh-undo-plugin` 的关键路径：

```js
// 1) 借一个真实 turn，不调用模型
await agent.runMaintenance(async () => {
  operations.set(agent.id, op)
  agent.steer(markerUserMessage)   // 让 loop 打开 turn/start
})

// 2) pre-step 里重放，然后拒绝这一步
async preStep({ agent, turn }) {
  await commit(...)                // 追加 step/start + 隐藏标记 + 副本 + step/end
  return { kind: 'reject' }        // 不进入 LLM 调用
}

// 3) loop 自己追加 turn/end，turn 号天然连续
```

重放构造（`src/conversation.mjs`）的核心：

1. `Session.fromRestore(...)` 建一个 detached 克隆，用来试算；
2. 复用当前打开的 turn（`activeTurn=true`）；
3. `step = 当前 turn 内最后一个 step + 1`，追加 `step/start`；
4. 追加空 `developer/message` 的 `surfaceOp: replace`，遮住当前尾巴；
5. 把目标快照里的消息作为副本逐条 append：
   - 新 `message.id`；
   - tool-call id 重映射，并补对应的 `tool/call` 事件；
   - `data.turn/step` 改成**当前 maintenance step**；
   - assistant 去掉 `usage`（避免 token meter 重复计费）；
6. `step/end`；
7. 用 `Session.create(...)` + 格式 catalog 预验证整条日志。

因为 turn 是 agent 自己打开的、step 是插件在 turn 内打开的，
所以加载时 `requireTurn/requireStep/turn/start 连续` 全部通过。

---

## 4. 选定架构

```text
commands (/undo /redo)
  └─ runtime
      ├─ plan：目标边界、文件变更、目标对话快照
      ├─ journal：先落盘，再动文件
      ├─ agent.runMaintenance(...) + steer(marker)
      │    └─ agent/pre-step 拦截：
      │         ├─ history.snapshotBefore(seq)   （detached Session 折叠）
      │         ├─ replay.build(...)             （当前 turn/step 内）
      │         ├─ files.restore(...)
      │         ├─ session.append(prepared...)
      │         └─ return { kind: 'reject' }
      └─ session/event turn/end：
           ├─ sessions.flush(session)
           ├─ state.commit()                    （undo/redo 栈、hiddenRanges）
           └─ resolve command
```

组件职责：

| 模块 | 职责 |
| --- | --- |
| `src/history.mjs` | `Session.fromRestore` 折叠前缀，导出“目标对话快照” |
| `src/replay.mjs` | 在给定 turn/step 内构造合法重放事件（含 id/tool-call 重映射） |
| `src/runtime.mjs` | maintenance 编排、pre-step 拦截、turn/end 收尾 |
| `src/snapshot.mjs` / `git.mjs` | 文件快照（沿用现有 git 影子仓库） |
| `src/store.mjs` | state、伪锁、journal、原子写 |
| `src/commands.mjs` | web 命令入口：选目标 → 直接执行 |

---

## 5. undo 流程

```text
1. 用户选择目标用户消息 seq=target
2. plan:
     targetSnapshot = history.snapshotBefore(target)   // 可见消息列表
     fileChanges    = 现有快照计划（target 之后每个 step）
     lock(workspace)
3. journal = { id, target, before: 当前 state, changes, ... } → 原子写
4. 恢复文件（snapshot.restore）
5. agent.runMaintenance：
     steer(marker)                    // agent 打开 turn T
     pre-step:
        desired = targetSnapshot
        prepared = replay.build(desired, turn=T, step=1)
        append step/start, 隐藏标记, 副本, tool/call, step/end
        return reject                 // 模型不跑
6. turn/end:
     sessions.flush()
     state.undo.push({ target, endSeq, changes, hiddenRanges })
     state.redo = []
     journal = null
7. 返回结果，web 刷新
```

## 6. redo 流程

```text
1. base = state.redo.at(-1)
2. 恢复文件到 base.resultChanges（或按 base 目标重新计算）
3. 再次 runMaintenance + steer(marker)
4. pre-step 重放 base.targetSnapshot（同一个目标上下文）
5. turn/end：state.undo.push(反向记录)，state.redo.pop()
6. 若 redo 栈空，回到 head
```

**redo 不是“撤销 undo”，而是“再次应用同一个 rewind 目标”**，
因此它同样落在合法的 maintenance turn 里。

---

## 7. 重放构造规则（必须逐条满足）

1. **目标快照**：只取目标边界之前、当前 surface 可见的消息；
   用 detached `Session.fromRestore(prefix)` 的 surface fold 得到。
2. **公共前缀**：当前可见消息与目标快照逐条比较，保留公共前缀，
   只处理差异尾巴，避免整段重复。
3. **隐藏标记**：在**当前 step 内**追加空 `developer/message`，
   `surfaceOp: replace` 覆盖当前尾巴。
4. **副本**：
   - 每条消息新 id；
   - assistant 的 tool-call id 换新，并同步 `tool/result` 的
     `toolCallId` / `source.callId`；
   - 补 `tool/call` 事件（格式校验要求工具结果有配对生命周期）；
   - `data.turn/step` = 当前 maintenance turn/step；
   - assistant 删除 `usage`；
   - user/tool 副本带 `sourceEventSeqs`（指向原事件），assistant 不带。
5. **收尾**：`step/end`；turn/end 由 loop 自己追加。
6. **预验证**：用 `Session.create` / 格式 catalog 校验整条日志；
   不通过则整笔操作回滚（journal）。

---

## 8. 文件恢复

- 沿用现有 `SnapshotService`：每次 step 前 capture，记录 `start/end/files`。
- undo：按目标边界之后第一个改动文件的 step 的 `start` 树恢复。
- redo：恢复到 undo 前的 head（或目标边界状态）。
- **顺序**：先写 journal → 恢复文件 → append 重放 → flush → 清 journal。
- 崩溃恢复：
  - 有 journal 且日志里已有 `plugin/dsh-rewind/commit` 记录 → 视为已提交，
    只补 state；
  - 否则按 journal 回滚文件，并把对话恢复到 before 状态（再次走 maintenance
    重放，或标记为需人工确认）。
- 冲突：恢复前检查文件现状是否等于记录值，不一致则拒绝并提示。

---

## 9. 状态模型（schema v2）

```jsonc
{
  "schema": 2,
  "sessionId": "...",
  "revision": 12,
  "checkpoints": { "<messageId>": { "start": "...", "files": [...] } },
  "undo": [
    {
      "id": "uuid",
      "targetSeq": 42,
      "targetSnapshot": [ { "type": "...", "data": {...} } ],
      "changes": [ { "file": "...", "before": "...", "after": "..." } ],
      "ranges": [ { "start": 42, "end": 80 } ],
      "endSeq": 91,
      "createdAt": 0
    }
  ],
  "redo": [],
  "hiddenRanges": [ { "start": 42, "end": 80 } ],
  "journal": null
}
```

- `targetSnapshot` 可以懒计算（只存 targetSeq），但 web 需要快速恢复；
  先存快照，体积大时改存 seq + 按需折叠。
- `hiddenRanges` 给 UI 用：隐藏被 rewind 的原始消息和 maintenance 内部事件。

---

## 10. Web 显示

重放后 web 的转录仍会有：

- 被隐藏的原始消息（append-origin 历史）；
- maintenance turn 的 marker / 内部事件。

解决方式（按优先级）：

1. **客户端隐藏**：注册 web client 插件，读取 state 的 `hiddenRanges`，
   在会话视图中隐藏对应 seq 的消息与维护行；
2. **web 会话节点**：给 `ui-chat` 的 conversation node 增加对
   `developer/message` replace + `hiddenRanges` 的处理（需改客户包）；
3. 暂不处理，只保证模型上下文与文件正确（不作为验收）。

本阶段验收以 1 为主。

---

## 11. 失败模式

| 场景 | 行为 |
| --- | --- |
| 会话正在生成 | 拒绝 undo/redo |
| 工作区被其他会话占用 | 拒绝，提示稍后 |
| 日志预验证失败 | 不 append、不恢复文件，报错 |
| 文件恢复部分失败 | journal 保留，提示恢复 |
| maintenance turn 被中断 | 重启时按 journal/commit marker 恢复 |
| 目标已不可见 | 拒绝，提示重新选择 |
| compaction 改变 surface | 使用 detached 前缀折叠，不依赖旧 surface 代数 |

---

## 12. 测试策略

1. **重放契约（单元）**
   - 给定前缀日志 + 目标快照 + turn/step，构造事件；
   - 用 `Session.create` + 格式 catalog 解码，必须通过；
   - 覆盖 tool call/result 配对、usage 剥离、id 唯一。
2. **编排契约（fake agent）**
   - fake agent 实现 `runMaintenance/steer`，模拟 loop 追加 turn/start、turn/end；
   - undo → redo → 再次 undo，断言 turn 号连续、日志可解码。
3. **真实 rc.2**
   - 用安装版 `@deepseek-ai/dsh-session` + 格式读取器；
   - 断言“重放后重新 `Session.create` 不抛错”。
4. **web 冒烟**
   - `/undo`、`/redo`、刷新页面、重新打开会话；
   - 检查上下文占用、文件、消息数量。

---

## 13. 里程碑

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| M0 | `history` + `replay` 纯模块 + 格式校验单测 | 重放日志可被格式读取器接受 |
| M1 | maintenance 编排 + `/undo`（web） | 同 session 内 undo 后 reload 不报错 |
| M2 | `/redo` + undo/redo 栈 + 文件恢复 + journal | undo→redo→undo 全部合法、文件正确 |
| M3 | web 客户端隐藏 hiddenRanges | 刷新/重开会话后界面符合预期 |
| M4 | 冲突检测、清理、性能、文档 | 长会话与并发场景 |

---

## 14. 风险与开放问题

1. `agent.runMaintenance` 是公开 API，但跨 rc.x 的稳定性需回归测试。
2. maintenance turn 会在日志里留下空 turn 和 marker；UI 必须能隐藏。
3. `targetSnapshot` 的存储形式（快照 vs seq）需要按体积决定。
4. 与 compaction 的交互：目标边界之前若发生压缩，快照折叠要基于当时的日志。
5. token meter：副本必须剥 `usage`、且 surface 计价不能重复。
6. dsh-tui 暂不处理；若未来要支持，需要转录层读 surface 或再加 client。

---

## 15. 与旧文档的关系

- `dsh-tui-undo-redo-prd.md` 记录 v1–v5 的演进与失败原因，保留作背景。
- **本文件是 v6 的实现依据**：以 maintenance turn replay 取代
  “surface 隐藏 + turn 外追加副本”。
- 现有 `src/snapshot.mjs` / `collect.mjs` / `git.mjs` 继续使用；
  `src/revert.mjs` 的 `stage/clear` 与 `src/replay.mjs` 需要按本文重写。
