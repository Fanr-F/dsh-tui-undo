/**
 * dsh-tui surface for undo / redo.
 *
 * Dialogs come from the host (`ctx.get('tuiDialogs')`), so this module never
 * touches the terminal. Handlers resolve to a command result instead of
 * throwing: the harness renders failures as text, and a cancelled dialog is a
 * silent success so no draft is lost.
 */
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
const FILES_SHOWN = 8;
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const fail = (text) => ({ kind: 'error', text: text || '操作失败' });
const cancelled = () => ({ kind: 'success', text: '' });

function short(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function scopeMessage(preview, target, files) {
  const lines = [
    `回退到「${short(target?.text, 80) || '（附件消息）'}」之前`,
    `对话：隐藏 ${preview.hidden.turns} 轮、${preview.hidden.events} 条事件（可重做）`,
    files ? `文件：${preview.paths.length} 个` : '文件：不修改',
  ];
  for (const path of (files ? preview.paths : []).slice(0, FILES_SHOWN)) lines.push(`· ${path}`);
  if (preview.paths.length > FILES_SHOWN) lines.push(`· 另有 ${preview.paths.length - FILES_SHOWN} 个文件`);
  return lines.join('\n');
}

export function createCommands({ runtime, dialogs }) {
  const api = () => {
    const service = dialogs();
    if (!service) throw new Error('dsh-tui 的对话框服务不可用');
    return service;
  };
  const sessionOf = (invocation) => {
    const session = invocation?.agent?.session;
    if (!session?.id) throw new Error('当前没有可操作的会话');
    return session;
  };

  async function undo(invocation) {
    let session;
    let service;
    try {
      session = sessionOf(invocation);
      service = api();
    } catch (error) {
      return fail(errorText(error));
    }

    let targets;
    try {
      targets = await runtime.targets(session);
    } catch (error) {
      return fail(errorText(error));
    }
    if (!targets.length) return fail('还没有可回退的用户消息');

    const options = targets.map((target) => ({
      id: target.messageID,
      label: short(target.text, 100) || '（附件消息）',
      description: `隐藏 ${target.hidden.turns} 轮 · ${target.hidden.events} 条事件`,
    }));
    let messageID;
    try {
      messageID = await service.select({ title: '回退到哪条消息之前？', options, signal: invocation.signal, timeoutMs: DIALOG_TIMEOUT_MS });
    } catch (error) {
      return fail(errorText(error));
    }
    if (messageID === undefined) return cancelled();
    const target = targets.find((item) => item.messageID === messageID);
    if (!target) return fail('这条消息已经不在当前对话中');

    let preview;
    try {
      preview = await runtime.preview(session, target.seq);
    } catch (error) {
      return fail(errorText(error));
    }

    let scope;
    try {
      scope = await service.select({
        title: '回退范围',
        options: [
          { id: 'both', label: '对话 + 文件', description: `同时把 ${preview.paths.length} 个文件恢复原状` },
          { id: 'conversation', label: '仅对话', description: '工作区文件保持不变' },
        ],
        signal: invocation.signal,
        timeoutMs: DIALOG_TIMEOUT_MS,
      });
    } catch (error) {
      return fail(errorText(error));
    }
    if (scope === undefined) return cancelled();
    const files = scope !== 'conversation';

    let approved;
    try {
      approved = await service.confirm({
        title: '确认回退？',
        message: scopeMessage(preview, target, files),
        confirmLabel: '回退',
        cancelLabel: '取消',
        signal: invocation.signal,
        timeoutMs: DIALOG_TIMEOUT_MS,
      });
    } catch (error) {
      return fail(errorText(error));
    }
    if (!approved) return cancelled();

    try {
      const result = await runtime.undo({ session, seq: target.seq, files });
      const changed = result.files?.length ?? 0;
      const failed = result.restore?.failed?.length ?? 0;
      return {
        kind: 'success',
        text:
          `已回退到「${short(target?.text, 40) || '（附件消息）'}」之前：隐藏 ${result.hidden.turns} 轮，` +
          (files ? `文件 ${changed} 个${failed ? `，${failed} 个失败` : ''}` : '文件未改动') +
          '。可用 /redo 重做。',
      };
    } catch (error) {
      return fail(errorText(error));
    }
  }

  async function redo(invocation) {
    let session;
    let service;
    try {
      session = sessionOf(invocation);
      service = api();
    } catch (error) {
      return fail(errorText(error));
    }

    let status;
    try {
      status = await runtime.status(session);
    } catch (error) {
      return fail(errorText(error));
    }
    if (!status.redoAvailable) return fail('没有可重做的回退');

    let approved;
    try {
      approved = await service.confirm({
        title: '重做回退？',
        message: `重新写回一步被隐藏的对话，并把文件恢复到回退前的状态。\n当前回退到「${short(status.revert.messageID, 60)}」。`,
        confirmLabel: '重做',
        cancelLabel: '取消',
        signal: invocation.signal,
        timeoutMs: DIALOG_TIMEOUT_MS,
      });
    } catch (error) {
      return fail(errorText(error));
    }
    if (!approved) return cancelled();

    try {
      const result = await runtime.redo({ session });
      return { kind: 'success', text: result.cleared ? '已重做到最新：回退记录已清空。' : `已重做一步，当前回退到「${short(result.boundarySeq, 20)}」。` };
    } catch (error) {
      return fail(errorText(error));
    }
  }

  return { undo, redo };
}
