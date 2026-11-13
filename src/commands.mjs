/**
 * `/undo` and `/redo` for the dsh command surface.
 *
 * The web composer invokes a registered command and renders the returned text,
 * so undo must be usable without any client plugin: `/undo` lists the turns,
 * `/undo <n>` applies one immediately. When a TUI dialog service is present the
 * same selection happens in a picker instead. Either way a chosen target is
 * applied at once — there is no second confirmation.
 */
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
/** A dialog that settles faster than this never really opened. */
const INSTANT_CANCEL_MS = 250;

const errorText = (error) => (error instanceof Error ? error.message : String(error));
const fail = (text) => ({ kind: 'error', text: text || '操作失败' });
const cancelled = (targets) => ({
  kind: 'success',
  text: `已取消（${targets?.length ?? 0} 个候选，可用 /undo 1 直接回退最近一条）。`,
});

function short(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function fileSummary(result) {
  if (result.filesAvailable === false) return '只回退了对话（未找到 git，文件未改动）';
  const changed = result.files ?? 0;
  const failed = result.restored?.failed?.length ?? 0;
  if (!changed) {
    const known = result.snapshots ?? 0;
    return `没有文件需要恢复（本会话记录了 ${known} 个步骤快照）`;
  }
  const names = (result.paths ?? []).slice(0, 5).join('、');
  return `恢复了 ${changed} 个文件${names ? `（${names}）` : ''}${failed ? `，${failed} 个失败` : ''}`;
}

export function createCommands({ runtime, dialogs, logger, log }) {
  const dialogService = () => {
    try {
      return dialogs?.();
    } catch {
      return undefined;
    }
  };
  const note = (message) => {
    try {
      log?.write('command', message);
      logger?.(message);
    } catch {
      /* logging must never break the command */
    }
  };

  /**
   * Candidate list, newest first.
   *
   * The conversation's first message *is* a valid target: rewinding before it
   * empties the transcript and restores the files that turn created, which is
   * exactly what "undo the only thing I just did" means.
   */
  async function candidates(session) {
    const targets = await runtime.targets(session);
    return [...targets].reverse();
  }

  function listing(targets) {
    const lines = targets.map((target, index) => `${index + 1}. ${short(target.text, 60) || '（附件消息）'}`);
    return [
      '可回退到以下消息之前：',
      ...lines,
      '',
      `发送 /undo <编号> 立即回退（例如 /undo 1），/undo 不带编号会重新显示这个列表。`,
    ].join('\n');
  }

  async function undo(invocation) {
    const session = invocation?.agent?.session;
    if (!session?.id) return fail('当前没有可操作的会话');
    let targets;
    try {
      targets = await candidates(session);
    } catch (error) {
      return fail(errorText(error));
    }
    note(`/undo：${targets.length} 个候选`);
    if (!targets.length) return fail('还没有可回退的用户消息');

    const argument = String(invocation?.rawInput ?? invocation?.input ?? '').trim();

    if (argument) {
      const index = Number.parseInt(argument, 10);
      const target = Number.isSafeInteger(index) ? targets[index - 1] : undefined;
      if (!target) return fail(`没有第 ${argument} 条可回退的消息。\n\n${listing(targets)}`);
      return apply(invocation.agent, target);
    }

    const service = dialogService();
    if (service?.select) {
      let choice;
      const opened = Date.now();
      try {
        choice = await service.select({
          title: '回退到哪条消息之前？',
          options: targets.map((target, index) => ({
            id: String(index + 1),
            label: target.label,
            description: `第 ${targets.length - index} 近的一条消息`,
          })),
          // Deliberately no `signal`: a command signal that is already aborted
          // settles the dialog instantly with "cancelled" and the command would
          // look like it did nothing.
          timeoutMs: DIALOG_TIMEOUT_MS,
        });
      } catch (error) {
        note(`/undo 选择框失败：${errorText(error)}`);
        return fail(`${errorText(error)}\n\n${listing(targets)}`);
      }
      if (choice === undefined || choice === null) {
        // Nothing was chosen. A dialog that never really opened (an aborted
        // command signal, a screen without dialog chrome) settles in the same
        // tick; fall back to the text list so the command is never silent.
        note('/undo 选择框没有返回结果');
        if (Date.now() - opened < INSTANT_CANCEL_MS) return { kind: 'success', text: listing(targets) };
        return cancelled(targets);
      }
      const target = targets[Number.parseInt(choice, 10) - 1];
      if (!target) return fail('这条消息已经不在当前对话中');
      return apply(invocation.agent, target);
    }

    return { kind: 'success', text: listing(targets) };
  }

  async function apply(agent, target) {
    note(`/undo：回退到 seq ${target.seq}`);
    try {
      const result = await withDeadline(runtime.undo({ agent, seq: target.seq }));
      return {
        kind: 'success',
        text: `已回退到「${short(target.text, 40) || '（附件消息）'}」之前：${fileSummary(result)}。可用 /redo 重做。`,
      };
    } catch (error) {
      note(`/undo 失败：${errorText(error)}`);
      return fail(hint(errorText(error)));
    }
  }

  async function redo(invocation) {
    const agent = invocation?.agent;
    if (!agent?.session?.id) return fail('当前没有可操作的会话');
    note('/redo：执行');
    try {
      const result = await withDeadline(runtime.redo({ agent }));
      return { kind: 'success', text: `已重做上一次回退：${fileSummary(result)}。` };
    } catch (error) {
      note(`/redo 失败：${errorText(error)}`);
      return fail(hint(errorText(error)));
    }
  }

  /** Attach the log location so a failure is actionable. */
  function hint(text) {
    const file = runtime.logFile;
    return file ? `${text}\n（详细日志：${file}）` : text;
  }

  /** Show the last message list the host submitted to the model. */
  async function context(invocation) {
    const session = invocation?.agent?.session;
    if (!session?.id) return fail('当前没有可操作的会话');
    const path = runtime.contextPath(session.id);
    if (!path) return fail('提交内容日志未启用（config.contextLog = false）');
    let last;
    try {
      last = await runtime.lastContext(session.id);
    } catch (error) {
      return fail(errorText(error));
    }
    if (!last) {
      return {
        kind: 'success',
        text: `还没有记录到提交给模型的内容。\n下一次请求之后会写入：${path}`,
      };
    }
    const time = new Date(last.at ?? Date.now()).toLocaleString('zh-CN');
    const lines = [
      `最近一次提交给模型的内容（${time}，回合 ${last.turn ?? '?'}，会话 seq ${last.seq ?? '?'}）：`,
      `共 ${last.count} 条消息、${last.chars} 字符；完整 JSONL：${path}`,
      '',
      ...last.messages
        .slice(0, 12)
        .map((message, index) => `${index + 1}. [${message.role}] ${short(message.text, 120) || '（空）'}`),
    ];
    if (last.messages.length > 12) lines.push(`… 另有 ${last.messages.length - 12} 条，见文件`);
    return { kind: 'success', text: lines.join('\n') };
  }

  /** Self-check: what the plugin thinks it can do in this session. */
  async function status(invocation) {
    const session = invocation?.agent?.session;
    if (!session?.id) return fail('当前没有可操作的会话');
    try {
      const info = await runtime.status(session);
      const targets = await runtime.targets(session);
      const recent = info.snapshottedSeqs.slice(-8).join(', ');
      return {
        kind: 'success',
        text: [
          `插件：已加载（会话 ${session.id}）`,
          `工作目录：${info.cwd ?? '未知'}`,
          `文件恢复：${info.filesAvailable ? '可用' : '不可用（未找到 git）'}`,
          `已记录步骤快照：${info.snapshots} 个${recent ? `，最近 seq ${recent}` : ''}`,
          `可回退的消息：${targets.length} 条`,
          `撤回栈：${info.undoDepth} 次，可重做：${info.redoDepth} 次`,
          `日志：${runtime.logFile ?? '未启用'}`,
          `提交内容日志：${runtime.contextDirectory ?? '未启用'}`,
          info.busy ? '注意：有未完成的撤回记录' : '状态：空闲',
        ].join('\n'),
      };
    } catch (error) {
      return fail(errorText(error));
    }
  }

  return { undo, redo, status, context };
}

/** Turn a hung maintenance turn into visible feedback instead of silence. */
async function withDeadline(promise, ms = 60_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${ms / 1000} 秒内没有完成，请稍后查看结果或用 /redo 检查`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
