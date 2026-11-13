# dsh-tui-undo

给 DeepSeek Harness 的会话和工作区加上 **撤回 / 重做**。

- `/undo`：回到某条用户消息之前，模型上下文和工作区文件一起回退；
- `/redo`：把上一次撤回再放回去；
- **重新加载会话永远不会坏**：重放的内容写在一个真实的回合（turn）里。

## 原理（一句话）

dsh 的会话日志是只追加的，并且持久化时严格校验「每条消息必须属于某个打开的
turn + step」。所以插件**不伪造 turn、不截断日志、不 fork 会话**：它向 agent
借一个真实的、不调用模型的维护回合（`agent.runMaintenance()` + 一条 steer 标记），
在 `agent/pre-step` 里把目标对话重放成这个回合的一个 step，然后
`return { kind: 'reject' }` 让模型不跑。回合号由 agent 自己递增，`turn/end`
也由宿主追加，日志因此始终合法。

可见性仍然只有一种手段：`surfaceOp: replace` 的隐藏标记。被替换掉的原始消息
留在日志里，它们的 seq 永远有效，所以文件快照和「重做到哪一步」都能稳定引用。

## 安装

插件需要宿主已经加载的 `@deepseek-ai/dsh-session` 与格式校验目录。它是
`link:` 安装，裸包名解析不到 profile 的 `node_modules`，所以运行时会按顺序查找：

1. 直接 `import` 包名（正常安装时可用）；
2. `DSH_MODULE_ROOT` 或配置里的 `moduleRoot`；
3. `$DSH_HOME/profiles/*/node_modules`；
4. 全局 dsh 安装目录。

```powershell
dsh plugin --profile web add link:D:/Code/dsh-tui-undo
```

`package.json` 里带 `dsh.bundle.patch`，装完会自动出现在
`dsh --profile web --dump-config` 的行列表里。

## 使用

Web 输入框里：

```
/undo          列出可回退的消息（最近的在最前，第一条消息不算目标）
/undo 2        立刻回退到第 2 条之前
/redo          重做上一次回退
```

dsh-tui 里如果宿主提供 `tuiDialogs`，`/undo` 会弹出选择框；选完立即生效，
没有第二次确认。web 只装 host 半边时 `/undo` 输出候选列表、`/undo <n>` 执行。

## 文件恢复

- 有 `git`：用影子仓库记录每个 step 前后的文件树，撤回时把目标边界之后被改过的
  文件逐个还原；重做时还原这次撤回改动过的文件。
- 没有 `git`：只回退对话，并在结果里说明。

## 崩溃安全

每次操作先写 journal（含计划中的状态和回滚所需的文件树），再恢复文件、追加日志、
flush，最后在 `turn/end` 时落最终状态。进程被杀后，下一次 `agent/pre-step` 会：

- 日志里已有 `plugin:dsh-tui-undo/commit` 标记 → 直接采用计划状态；
- 否则回滚文件并清掉 journal。

## 已知限制

- 界面上隐藏旧行依赖随包发布的 web 客户端（`dsh.client`）：它按 state 里的
  `hiddenRanges` 过滤 `conversation.chat.flow`。只装 host 半边时，模型上下文和
  文件仍然正确，但转录里还能看到被替换的旧行。
- **dsh-tui**：只保证功能，不保证界面。`/undo` `/undo <n>` `/redo`、文件恢复、
  重新加载都正常，但 dsh-tui 的转录按追加顺序渲染 `channel.rows`，不读 surface，
  也没有公开的行过滤点，所以撤回后旧回复仍留在屏幕上、重做后会出现副本。
  这是**有意划定的范围**：需要界面回退时用 dsh-tui 原生 `/rewind`（fork 式，
  不恢复文件），或者用 web。
- 不撤销外部副作用（发送的消息、网页操作、数据库写入）。
- 会话正在生成、或同一工作区有别的会话在操作时，撤回会被拒绝。

## 测试

```powershell
npm test                    # 32 个测试，含真实 rc.2 的格式校验
npm run verify:replay       # 只跑真实宿主的重放/重载验证
npm run verify:manifest     # dsh-plugin.json 校验
```

`test/host-format.test.mjs` 直接调用安装版
`@deepseek-ai/dsh-session` 与 `dsh-session-format-catalog`：它断言重放后的日志
能被重新打开，同时断言 v5 那套「turn 外追加消息」的写法会被拒绝。
