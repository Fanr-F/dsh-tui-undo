import { createCommands } from './commands.mjs';
import { loadHost } from './host.mjs';
import { createLog } from './log.mjs';
import { RewindRuntime, defaultRewindRoot } from './runtime.mjs';
import { join } from 'node:path';

export const name = 'dsh-tui-undo';
export const inject = ['agents', 'sessions'];

const json = (response, status, value) => {
  if (response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};

async function readJson(request) {
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > 64 * 1024) throw new Error('请求过大');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

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
  const log = createLog({
    file:
      config.log === false
        ? undefined
        : typeof config.log === 'string'
          ? config.log
          : join(root, 'dsh-tui-undo.log'),
  });
  log.write('plugin', 'install', { root, enabled: config.log !== false });
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
  log.write('plugin', host.available === false ? 'host modules unavailable' : 'host modules loaded', {
    reason: host.reason,
    version: host.Session?.name ?? host.Session?.constructor?.name,
    catalog: Boolean(host.catalog),
  });

  const runtime = new RewindRuntime({
    root,
    host,
    log,
    cwdOf: async (session) => ctx.get?.('workingDirectory')?.get(session) ?? session.header?.cwd,
    flush: async (session) => ctx.sessions?.flush?.(session),
    logger: ctx.logger,
    scope: config.scope ?? '.',
    contextLog: config.contextLog,
    contextLimit: config.contextLimit,
  });

  ctx.effect(() => () => runtime.dispose?.());

  ctx.logger?.info?.(
    host.available
      ? 'dsh-tui-undo: 就绪（撤回在一个真实的维护回合内重放对话）'
      : `dsh-tui-undo: 已加载，但撤回不可用：${host.reason}`,
  );

  ctx.on('agent/pre-step', (payload, next) => runtime.preStep(payload, next), { prepend: true });
  ctx.on('session/event', (session, event) => runtime.event(session, event));

  // The web client asks for `hiddenRanges` here; a host without a web server
  // (dsh-tui) simply never resolves these services.
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: '/api/dsh-tui-undo/state',
        handler: async (request, response) => {
          const rejection = scope.connection.requestRejection(request);
          if (rejection !== undefined) {
            response.writeHead(rejection);
            response.end();
            return;
          }
          if (request.method !== 'POST') {
            json(response, 405, { error: 'POST required' });
            return;
          }
          try {
            const body = await readJson(request);
            json(response, 200, await runtime.stateFor(body.sessionId));
          } catch (error) {
            json(response, 409, { error: error?.message ?? String(error) });
          }
        },
      }),
    );
  });

  ctx.inject(['commands'], (scope) => {
    const commands = createCommands({
      runtime,
      log,
      dialogs: () => ctx.get?.('tuiDialogs'),
      logger: (message) => ctx.logger?.warn?.(`dsh-tui-undo ${message}`),
    });
    const rows = [
      ['undo', '回退到之前的某条消息（可重做）', commands.undo, { hint: '编号；不带编号会列出可回退的消息' }],
      ['redo', '重做上一次回退', commands.redo],
      ['undo-status', '查看撤回插件状态（自检）', commands.status],
      ['undo-context', '查看最近一次提交给模型的内容', commands.context],
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
