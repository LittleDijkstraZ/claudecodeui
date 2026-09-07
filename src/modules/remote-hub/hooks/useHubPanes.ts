import { useCallback, useRef, useState } from 'react';
import type { WorkspaceNavigationState } from '@/shared/types';

/** Keeps one App per visited machine so navigation preserves terminal and workspace state. */
export function useHubPanes() {
  // Each machine's initial URL stays fixed for the lifetime of this hub window.
  const [panes, setPanes] = useState<Array<{ remoteId: string; initialSessionId: string | null }>>([]);
  // Navigation metadata is reported by each retained App, never guessed from another machine.
  const [navigation, setNavigation] = useState<Record<string, WorkspaceNavigationState>>({});
  // Confirms that a selected conversation has actually reached the corresponding frame.
  const [selections, setSelections] = useState<Record<string, string>>({});
  // Main chat can stay visible beside a selected tool tab or be covered by a maximized panel.
  const [chatVisibility, setChatVisibility] = useState<Record<string, { sessionId: string | null; visible: boolean }>>({});
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
    setSelections(current => current[remoteId] === sessionId ? current : { ...current, [remoteId]: sessionId });
    return true;
  }, []);
  const openSettings = useCallback((remoteId: string) => {
    frames.current.get(remoteId)?.contentWindow?.postMessage({ kind: 'cloudcli:settings' }, location.origin);
  }, []);
  const acceptNavigation = useCallback((remoteId: string, value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const nav = value as WorkspaceNavigationState;
    if ((nav.sessionId !== null && typeof nav.sessionId !== 'string') || typeof nav.activeTab !== 'string' || !Array.isArray(nav.tabs) || nav.tabs.length > 40) return;
    if (!nav.tabs.every(tab => tab && typeof tab.id === 'string' && typeof tab.label === 'string' && tab.label.length <= 100)) return;
    if (!nav.tabs.some(tab => tab.id === nav.activeTab)) return;
    const requested = pending.current.get(remoteId);
    if (requested && requested !== nav.sessionId) return;
    setNavigation(current => ({ ...current, [remoteId]: { sessionId: nav.sessionId, activeTab: nav.activeTab, tabs: nav.tabs } }));
    frames.current.get(remoteId)?.contentWindow?.postMessage({ kind: 'cloudcli:workspace-nav-ready', sessionId: nav.sessionId }, location.origin);
  }, []);
  const selectTab = useCallback((remoteId: string, tab: string) => {
    if (!navigation[remoteId]?.tabs.some(item => item.id === tab)) return;
    frames.current.get(remoteId)?.contentWindow?.postMessage({ kind: 'cloudcli:workspace-tab', tab, sessionId: navigation[remoteId].sessionId }, location.origin);
  }, [navigation]);
  const acceptChatVisibility = useCallback((remoteId: string, value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const state = value as { sessionId: string | null; visible: boolean };
    if ((state.sessionId !== null && typeof state.sessionId !== 'string') || typeof state.visible !== 'boolean') return;
    setChatVisibility(current => ({ ...current, [remoteId]: { sessionId: state.sessionId, visible: state.visible } }));
  }, []);
  return { chatVisibility, acceptChatVisibility, navigation, selections, acceptNavigation, selectTab, panes, navigate, register, remoteForSource, markReady, acceptSelection, openSettings };
}
