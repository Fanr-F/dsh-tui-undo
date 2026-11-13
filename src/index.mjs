import { createCommands } from './commands.mjs';
import { loadHost } from './host.mjs';
import { RewindRuntime, defaultRewindRoot } from './runtime.mjs';

export const name = 'dsh-tui-undo';
export const inject = ['agents', 'sessions'];

/**
 * dsh plugin entry.
 *
 * Undo/redo borrow a real maintenance turn from the agent, so replayed messages
 * land inside a legal turn/step and the session log still reloads. Everything
 * host-specific (session class, format catalog, message projections) is taken
 * from the running installation; when it is unavailable the plugin still
 * activates and explains why instead of breaking the composition.
 */
export async function install(ctx, config = {}) {
  const root = config.storageDir ?? defaultRewindRoot();
  let host;
  try {
    host = await loadHost({
      moduleRoot: config.moduleRoot,
      projections: ctx.sessions?.messageProjections ?? [],
      logger: ctx.logger,
    });
  } catch (error) {
    ctx.logger?.warn?.(`dsh-tui-undo: 初始化失败，撤回功能已禁用：${error?.message ?? error}`);
    host = { available: false, reason: `撤回初始化失败：${error?.message ?? error}` };
  }

  const runtime = new RewindRuntime({
    root,
    host,
    cwdOf: async (session) => ctx.get?.('workingDirectory')?.get(session) ?? session.header?.cwd,
    flush: async (session) => ctx.sessions?.flush?.(session),
    logger: ctx.logger,
    scope: config.scope ?? '.',
  });

  ctx.effect(() => () => runtime.dispose?.());

  ctx.logger?.info?.(
    host.available
      ? 'dsh-tui-undo: 就绪（撤回在一个真实的维护回合内重放对话）'
      : `dsh-tui-undo: 已加载，但撤回不可用：${host.reason}`,
  );

  ctx.on('agent/pre-step', (payload, next) => runtime.preStep(payload, next), { prepend: true });
  ctx.on('session/event', (session, event) => runtime.event(session, event));

  ctx.inject(['commands'], (scope) => {
    const commands = createCommands({ runtime, dialogs: () => ctx.get?.('tuiDialogs') });
    const rows = [
      ['undo', '回退到之前的某条消息（可重做）', commands.undo, { hint: '编号；不带编号会列出可回退的消息' }],
      ['redo', '重做上一次回退', commands.redo],
    ];
    for (const [command, description, handler, input] of rows) {
      scope.effect(() => {
        const off = scope.commands.register({ name: command, description, handler, ...(input ? { input } : {}) });
        return () => off();
      });
    }
  });
}

export const apply = (ctx, config) => install(ctx, config);
