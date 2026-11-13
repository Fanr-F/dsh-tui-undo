/**
 * Web client half: hide the rows a rewind replaced.
 *
 * The transcript is built from the append-only log, so the messages an undo
 * hid (and the copies a redo appended) are still delivered to the browser.
 * The plugin knows which sequence ranges are superseded; this module asks for
 * them and filters the chat flow before it renders.
 *
 * It is a hand-written browser module because the host loads client halves as
 * `window.__ModuleLoader__.load({ id, factory })` with CommonJS `require`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tui-undo',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');

    const name = 'dsh-tui-undo-client';
    const inject = ['slots', 'sessions'];

    const EMPTY = { revision: -1, hiddenRanges: [] };
    const states = new Map();
    const listeners = new Set();

    const inside = (ranges, seq) => Number.isSafeInteger(seq) && ranges.some((range) => seq >= range.start && seq <= range.end);
    const seqOf = (node) => node?.anchorSeq ?? node?.data?.seq;

    function publish(sessionId, value) {
      const previous = states.get(sessionId);
      if (previous && (previous.revision ?? -1) > (value.revision ?? -1)) return;
      states.set(sessionId, value);
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    async function load(sessionId, signal) {
      try {
        const response = await fetch('/api/dsh-tui-undo/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          signal,
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '撤回状态不可用');
        publish(sessionId, value);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        publish(sessionId, { ...(states.get(sessionId) ?? EMPTY), error: error.message });
      }
    }

    function useRewindState(sessionId) {
      return React.useSyncExternalStore(
        subscribe,
        () => states.get(sessionId) || EMPTY,
        () => EMPTY,
      );
    }

    /**
     * Win the `conversation.chat.flow` single slot with a filtering wrapper.
     *
     * A `single` slot renders its *lowest* priority entry, and registering an
     * entry is the only public way to publish a change. So instead of mutating
     * the host's ledger row (fragile, and invisible to the renderer's version
     * cache), this registers its own wrapper one step below the host's
     * priority and calls the host component from inside it.
     */
    function decorateFlow(ctx) {
      const slot = 'conversation.chat.flow';
      let original;
      let registration;
      let busy = false;
      let stopped = false;

      function RewindFlow(props) {
        const state = useRewindState(props.sessionId);
        const ranges = Array.isArray(state.hiddenRanges) ? state.hiddenRanges : EMPTY.hiddenRanges;
        const nodes = props.useChat ? props.useChat((snapshot) => snapshot.nodes) : undefined;

        React.useEffect(() => {
          const controller = new AbortController();
          void load(props.sessionId, controller.signal);
          return () => controller.abort();
        }, [props.sessionId]);

        React.useEffect(() => {
          let source;
          try {
            source = ctx.sessions?.binding?.(props.sessionId)?.eventSource;
          } catch {
            source = undefined;
          }
          if (!source?.subscribe) return undefined;
          let last = -1;
          let timer;
          const dispose = source.subscribe(() => {
            const entries = source.getSnapshot?.()?.entries;
            const tail = entries?.at?.(-1);
            const seq = tail?.event?.seq ?? tail?.seq ?? -1;
            if (seq === last) return;
            last = seq;
            clearTimeout(timer);
            timer = setTimeout(() => void load(props.sessionId), 80);
          });
          return () => {
            clearTimeout(timer);
            dispose?.();
          };
        }, [props.sessionId]);

        if (!original) return null;
        if (!ranges.length || !nodes) return React.createElement(original, props);

        const hidden = (node) => inside(ranges, seqOf(node));
        const entries = Array.isArray(props.entries)
          ? props.entries.filter((entry) => entry.kind !== 'node' || !hidden(nodes.get(entry.key)))
          : props.entries;
        const useChatGroup = props.useChatGroup
          ? (key, selector) =>
              props.useChatGroup(key, (group) => {
                if (!group) return selector(group);
                const members = group.members.filter((member) => !hidden(nodes.get(member.key)));
                return selector(members.length ? { ...group, members } : undefined);
              })
          : props.useChatGroup;

        return React.createElement(original, { ...props, entries, useChatGroup });
      }
      RewindFlow.__dshTuiUndoFlow = true;

      function reconcile() {
        if (stopped || busy) return;
        busy = true;
        try {
          const host = ctx.slots.entries(slot).find((entry) => !entry.component?.__dshTuiUndoFlow);
          if (!host || typeof host.component !== 'function') return;
          original = host.component;
          if (registration) return;
          // The elected entry supplies the slot's inject (useChat/useChatGroup/
          // keyed node hooks) and its store; only `children` must be dropped,
          // because that subtree is already declared by the host's entry.
          const { children: _children, ...options } = host.options;
          registration = ctx.slots.register(
            { ...options, name: slot, priority: (options.priority ?? 0) - 1 },
            RewindFlow,
          );
        } catch {
          // A colliding priority means somebody else already shadows the flow;
          // leaving the host's component untouched is the safe outcome.
          registration = undefined;
        } finally {
          busy = false;
        }
      }

      const unsubscribe = ctx.slots.subscribe(slot, reconcile);
      reconcile();

      return () => {
        stopped = true;
        unsubscribe?.();
        registration?.();
        registration = undefined;
        original = undefined;
      };
    }

    function apply(ctx) {
      ctx.effect(() => decorateFlow(ctx));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
