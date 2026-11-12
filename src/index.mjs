import { createCommands } from './commands.mjs';
import { createSurfacePort } from './host.mjs';
import { RewindRuntime, defaultRewindRoot } from './runtime.mjs';

export const name = 'dsh-tui-undo';
export const inject = ['agents', 'sessions'];

/**
 * dsh plugin entry.
 *
 * Every session is driven through its surface (`surfaceOp` markers), which is
 * the only mutation an append-only DSH log allows. A session the host cannot
 * drive simply keeps undo disabled and reports why.
 */
export async function install(ctx, config = {}) {
  const root = config.storageDir ?? defaultRewindRoot();
  const runtime = new RewindRuntime({
    root,
    portFor: async (session) => createSurfacePort({ session }),
    cwdOf: async (session) => ctx.get?.('workingDirectory')?.get(session) ?? session.header?.cwd,
    logger: ctx.logger,
  });

  ctx.effect(() => () => runtime.dispose?.());

  ctx.on(
    'agent/pre-step',
    (payload, next) => {
      const session = payload?.agent?.session;
      if (!session?.id) return next();
      return runtime.preStep({ session }).then(
        () => next(),
        (error) => {
          ctx.logger?.warn?.(`dsh-tui-undo: pre-step snapshot skipped: ${error?.message ?? error}`);
          return next();
        },
      );
    },
    { prepend: true },
  );

  ctx.on('session/event', (session, event) => {
    runtime.event({ session, event }).catch((error) => {
      ctx.logger?.warn?.(`dsh-tui-undo: step snapshot skipped: ${error?.message ?? error}`);
    });
  });

  ctx.inject(['commands'], (scope) => {
    const commands = createCommands({ runtime, dialogs: () => ctx.get?.('tuiDialogs') });
    for (const [command, description, handler] of [
      ['undo', '回退到之前的消息（可重做）', commands.undo],
      ['redo', '重做上一次回退', commands.redo],
    ]) {
      scope.effect(() => {
        const off = scope.commands.register({ name: command, description, handler });
        return () => off();
      });
    }
  });
}

export const apply = (ctx, config) => install(ctx, config);
