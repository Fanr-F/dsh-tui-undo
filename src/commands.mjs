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

const errorText = (error) => (error instanceof Error ? error.message : String(error));
const fail = (text) => ({ kind: 'error', text: text || '操作失败' });
const cancelled = () => ({ kind: 'success', text: '' });

function short(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function fileSummary(result) {
  const changed = result.files ?? 0;
  const failed = result.restored?.failed?.length ?? 0;
  if (!changed) return '没有文件需要恢复';
  return `恢复了 ${changed} 个文件${failed ? `（${failed} 个失败）` : ''}`;
}

export function createCommands({ runtime, dialogs }) {
  const dialogService = () => {
    try {
      return dialogs?.();
    } catch {
      return undefined;
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
      try {
        choice = await service.select({
          title: '回退到哪条消息之前？',
          options: targets.map((target, index) => ({
            id: String(index + 1),
            label: target.label,
            description: `第 ${targets.length - index} 近的一条消息`,
          })),
          signal: invocation.signal,
          timeoutMs: DIALOG_TIMEOUT_MS,
        });
      } catch (error) {
        return fail(errorText(error));
      }
      if (choice === undefined) return cancelled();
      const target = targets[Number.parseInt(choice, 10) - 1];
      if (!target) return fail('这条消息已经不在当前对话中');
      return apply(invocation.agent, target);
    }

    return { kind: 'success', text: listing(targets) };
  }

  async function apply(agent, target) {
    try {
      const result = await runtime.undo({ agent, seq: target.seq });
      return {
        kind: 'success',
        text: `已回退到「${short(target.text, 40) || '（附件消息）'}」之前：${fileSummary(result)}。可用 /redo 重做。`,
      };
    } catch (error) {
      return fail(errorText(error));
    }
  }

  async function redo(invocation) {
    const agent = invocation?.agent;
    if (!agent?.session?.id) return fail('当前没有可操作的会话');
    try {
      const result = await runtime.redo({ agent });
      return { kind: 'success', text: `已重做上一次回退：${fileSummary(result)}。` };
    } catch (error) {
      return fail(errorText(error));
    }
  }

  return { undo, redo };
}
