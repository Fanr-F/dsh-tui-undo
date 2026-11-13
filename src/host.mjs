/**
 * Host adapter: everything this plugin needs from the running DSH.
 *
 * The plugin is usually installed with `link:` so bare `@deepseek-ai/*`
 * imports do not resolve from its own directory; `host-modules.mjs` finds the
 * packages the host already loaded. Everything below is derived from *that*
 * session implementation, so event ids and projections are never duplicated.
 */
import { loadFormatCatalog, loadSessionModule } from './host-modules.mjs';
import { createDetachedFactory, createValidator } from './validate.mjs';

export class HostError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HostError';
    if (cause) this.cause = cause;
  }
}

/**
 * Resolve the host capabilities the runtime needs.
 *
 * `available: false` disables conversation rewind (the plugin still loads and
 * explains why) instead of failing the whole composition.
 */
export async function loadHost({ moduleRoot, projections = [], logger } = {}) {
  const sessionModule = await loadSessionModule({ moduleRoot });
  const catalogModule = await loadFormatCatalog({ moduleRoot });
  if (!sessionModule?.Session) {
    logger?.warn?.('dsh-tui-undo: 找不到宿主的 @deepseek-ai/dsh-session，撤回功能已禁用');
    return { available: false, reason: '找不到宿主的会话模块（@deepseek-ai/dsh-session）' };
  }
  const Session = sessionModule.Session;
  const catalog = catalogModule?.sessionFormatCatalog;
  if (!catalog) logger?.warn?.('dsh-tui-undo: 格式校验目录不可用，将跳过日志预校验');
  return {
    available: true,
    Session,
    catalog,
    createDetached: createDetachedFactory(Session, projections),
    validate: createValidator({ Session, catalog, projections }),
    appendPluginRecord: sessionModule.appendPluginRecord,
  };
}
