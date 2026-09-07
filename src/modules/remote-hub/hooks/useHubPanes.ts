import { useCallback, useRef, useState } from 'react';

/** Keeps one App per visited machine so navigation preserves terminal and workspace state. */
export function useHubPanes() {
  // Each machine's initial URL stays fixed for the lifetime of this hub window.
  const [panes, setPanes] = useState<Array<{ remoteId: string; initialSessionId: string | null }>>([]);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const ready = useRef(new Set<string>());
  const pending = useRef(new Map<string, string | null>());
  const navigate = useCallback((remoteId: string, sessionId: string | null) => {
    pending.current.set(remoteId, sessionId);
    setPanes(current => current.some(pane => pane.remoteId === remoteId) ? current : [...current, { remoteId, initialSessionId: sessionId }]);
    if (ready.current.has(remoteId)) frames.current.get(remoteId)?.contentWindow?.postMessage({ kind: 'cloudcli:navigate', sessionId }, location.origin);
  }, []);
  const register = useCallback((remoteId: string, frame: HTMLIFrameElement | null) => {
    if (frame) frames.current.set(remoteId, frame);
    else frames.current.delete(remoteId);
  }, []);
  const remoteForSource = useCallback((source: MessageEventSource | null) => {
    if (!source) return null;
    for (const [remoteId, frame] of frames.current) if (frame.contentWindow === source) return remoteId;
    return null;
  }, []);
  const markReady = useCallback((remoteId: string) => {
    ready.current.add(remoteId);
    if (pending.current.has(remoteId)) frames.current.get(remoteId)?.contentWindow?.postMessage({ kind: 'cloudcli:navigate', sessionId: pending.current.get(remoteId) }, location.origin);
  }, []);
  const acceptSelection = useCallback((remoteId: string, sessionId: string) => {
    // A frame can report its previous selection before a requested navigation settles.
    const target = pending.current.get(remoteId);
    if (target && target !== sessionId) return false;
    pending.current.delete(remoteId);
    return true;
  }, []);
  const openSettings = useCallback((remoteId: string) => {
    frames.current.get(remoteId)?.contentWindow?.postMessage({ kind: 'cloudcli:settings' }, location.origin);
  }, []);
  return { panes, navigate, register, remoteForSource, markReady, acceptSelection, openSettings };
}
