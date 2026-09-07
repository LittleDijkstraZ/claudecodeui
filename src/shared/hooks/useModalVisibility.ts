import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

const activeModals = new Set<object>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => activeModals.size > 0;

/** Used by shared DialogContent to report mounted modal coverage, including nested dialogs. */
export function useModalPresence(open: boolean) {
  const identity = useRef({});
  useLayoutEffect(() => {
    if (!open) return;
    const modal = identity.current;
    activeModals.add(modal); notify();
    return () => { activeModals.delete(modal); notify(); };
  }, [open]);
}

/** Used by embedded workspaces to hide host controls and preserve unread state while a dialog covers chat. */
export function useModalVisibility() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
