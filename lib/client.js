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
     * Replace a slot's registered component with a wrapper.
     *
     * `conversation.chat.flow` is a single entry owned by ui-chat and there is
     * no public "wrap" call, so the ledger row's component is swapped in place
     * and a throw-away registration publishes the change: the renderer caches
     * per slot version, and for a `single` slot the *lowest* priority renders,
     * so a probe at the highest priority is never visible.
     */
    function decorateFlow(ctx) {
      const slot = 'conversation.chat.flow';
      const swapped = new Map();
      let probe;
      let stopped = false;

      function bump() {
        try {
          if (probe) {
            probe();
            probe = undefined;
          }
          const entries = ctx.slots.entries(slot);
          const priority = Math.max(0, ...entries.map((entry) => entry.options.priority ?? 0)) + 1;
          const Probe = () => null;
          Probe.__dshTuiUndoProbe = true;
          probe = ctx.slots.register({ name: slot, priority }, Probe);
        } catch {
          // Another registrant may hold this priority; the swap still renders
          // on the next ledger change.
          probe = undefined;
        }
      }

      function wrapper(Original) {
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

          if (!ranges.length || !nodes) return React.createElement(Original, props);

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

          return React.createElement(Original, { ...props, entries, useChatGroup });
        }
        RewindFlow.__dshTuiUndoFlow = true;
        return RewindFlow;
      }

      function reconcile() {
        if (stopped) return;
        const live = new Set(ctx.slots.entries(slot));
        for (const entry of [...swapped.keys()]) if (!live.has(entry)) swapped.delete(entry);
        let changed = false;
        for (const entry of live) {
          if (swapped.has(entry) || entry.component?.__dshTuiUndoFlow || entry.component?.__dshTuiUndoProbe) continue;
          const previous = entry.component;
          if (typeof previous !== 'function') continue;
          entry.component = wrapper(previous);
          swapped.set(entry, previous);
          changed = true;
        }
        if (changed) bump();
      }

      const unsubscribe = ctx.slots.subscribe(slot, reconcile);
      reconcile();

      return () => {
        stopped = true;
        unsubscribe?.();
        if (probe) {
          probe();
          probe = undefined;
        }
        for (const [entry, previous] of swapped) entry.component = previous;
        swapped.clear();
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
