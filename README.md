# dsh-tui-undo

给 DeepSeek Harness 的会话和工作区加上 **撤回 / 重做**。

- `/undo`：回到某条用户消息之前，模型上下文和工作区文件一起回退；
- `/redo`：把上一次撤回再放回去；
- **重新加载会话永远不会坏**：重放的内容写在一个真实的回合（turn）里。

当前版本 **0.3.0**，发布页：<https://github.com/Fanr-F/dsh-tui-undo/releases>。

## 安装

从发布页的 tarball 安装（推荐，版本固定）：

```powershell
dsh plugin --profile web add https://github.com/Fanr-F/dsh-tui-undo/releases/download/v0.3.0/dsh-tui-undo-0.3.0.tgz
```

或直接从 GitHub 仓库安装：

```powershell
dsh plugin --profile web add github:Fanr-F/dsh-tui-undo
```

### 本地安装（开发）

直接指向工作目录，改代码后重启会话即可生效：

```powershell
dsh plugin --profile web add link:D:/Code/dsh-tui-undo
```

或者用本地打出来的 tgz 装一份快照（安装路径是绝对路径，必须是 `.tgz`）：

```powershell
dsh plugin --profile web add file:D:/Code/dsh-tui-undo/dsh-tui-undo-0.3.0.tgz
```

卸掉重装：

```powershell
dsh plugin --profile web remove dsh-tui-undo
```

插件运行时需要宿主已经加载的 `@deepseek-ai/dsh-session` 与格式校验目录。
`link:` 安装时裸包名解析不到 profile 的 `node_modules`，所以会按顺序查找：

1. 直接 `import` 包名（正常安装时可用）；
2. `DSH_MODULE_ROOT` 或配置里的 `moduleRoot`；
3. `$DSH_HOME/profiles/*/node_modules`；
4. 全局 dsh 安装目录。

`package.json` 里带 `dsh.bundle.patch`，装完会自动出现在
`dsh --profile web --dump-config` 的行列表里。

## 打包

仓库没有编译步骤：`src/*.mjs` 直接运行，`lib/client.js` 是手写的浏览器模块，
不需要 `tsc`、rollup 或 bundle。

打包前先跑测试（失败就不要打包）：

```powershell
npm test
```

然后打包：

```powershell
npm pack
```

产物是 `dsh-tui-undo-<version>.tgz`，版本取自 `package.json`。打进包里的只有
`files` 白名单：

```
src/  lib/  cordis.patch.yml  dsh-plugin.json  examples/  README.md  package.json
```

只看内容、不落盘：

```powershell
npm pack --dry-run
```

打包后先本地装一遍确认能起来，再上传：

```powershell
dsh plugin --profile web add file:D:/Code/dsh-tui-undo/dsh-tui-undo-0.3.0.tgz
```

发布时把 tgz 作为 GitHub Release 附件上传，可以用 `gh release upload <tag> <tgz>`，
或者直接在 Release 页面拖进去。

> 发新版本时记得同时改两处版本号：`package.json` 的 `version` 和
> `dsh-plugin.json` 的 `version`，然后用 `npm run verify:manifest` 校验。

## 使用

Web 输入框里：

```
/undo          列出可回退的消息（最近的在最前，第一条也算目标）
/undo 2        立刻回退到第 2 条之前
/redo          重做上一次回退
/undo-context  查看最近一次提交给模型的内容
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

## 日志

插件自己写一份诊断日志，默认在 `~/.dsh/rewind/dsh-tui-undo.log`
（`config.storageDir` 会一起改路径；`config.log === false` 关闭，
`config.log = '<path>'` 指定文件）。它记录：命令入口、每步快照、
撤回计划、journal、append 的真实序号、`turn/end` 结算，以及失败堆栈的首帧。

- `/undo-status` 会打印日志路径；
- 撤回失败时错误文本里也会附上路径；
- `node scripts/diagnose.mjs "<工作目录>"` 会把会话、state、影子仓库和日志一起打出来。

### 模型输入日志

每次真实步骤的 `agent/pre-step` 会记一份「即将提交给模型的完整消息列表」：

- 磁盘：`~/.dsh/rewind/context/<session>.jsonl`，一行一次请求，含角色、字符数、每条消息的文本（长文本会截断，默认每条约 8000 字符）；
- 命令：`/undo-context` 打印最近一次的摘要，并给出文件路径；
- 开关：`config.contextLog = false` 关闭，`config.contextLimit = <字符数>` 调整截断长度。

撤回后对比两次 `/undo-context` 的输出，就能直接看到模型上下文少了哪几轮。

## 兼容性

- Node.js >= 22；
- DSH `>= 0.2.2-rc.2 < 0.3.0`（在真实 rc.2 宿主上验证）；
- 插件形态是 DSH bundle：宿主半边 + 可选的 web 客户端半边。

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
npm test                    # 62 个测试，含真实 rc.2 的格式校验
npm run verify:replay       # 只跑真实宿主的重放/重载验证
npm run verify:manifest     # dsh-plugin.json 校验
```

`test/host-format.test.mjs` 直接调用安装版
`@deepseek-ai/dsh-session` 与 `dsh-session-format-catalog`：它断言重放后的日志
能被重新打开，同时断言「turn/end 之后追加消息」的写法会被格式校验拒绝。
