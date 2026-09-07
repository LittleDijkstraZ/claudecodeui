import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ConversationGroup, ConversationGroupsSnapshot } from '@/shared/types';
import {
  assignConversationGroup,
  createConversationGroup,
  deleteConversationGroup,
  listConversationGroups,
  renameConversationGroup,
} from '@/shared/api';

type GroupDialog = { kind: 'assign'; sessionId: string } | { kind: 'new'; groupId: string } | null;

type ConversationGroupsValue = ConversationGroupsSnapshot & {
  isLoading: boolean;
  error: string | null;
  revision: number;
  dialog: GroupDialog;
  refresh: () => Promise<void>;
  createGroup: (name: string) => Promise<ConversationGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  assignSession: (sessionId: string, groupId: string | null) => Promise<void>;
  openAssignment: (sessionId: string) => void;
  openNewConversation: (groupId: string) => void;
  closeDialog: () => void;
};

const ConversationGroupsContext = createContext<ConversationGroupsValue | null>(null);

// This context and its consumer hook intentionally share one module.
// eslint-disable-next-line react-refresh/only-export-components
export function useConversationGroups(): ConversationGroupsValue {
  const context = useContext(ConversationGroupsContext);
  if (!context) throw new Error('Conversation groups require ConversationGroupsProvider');
  return context;
}

export function ConversationGroupsProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ConversationGroupsSnapshot>({ groups: [], memberships: {} });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<GroupDialog>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await listConversationGroups();
      if (sequence !== requestSequence.current) return;
      setSnapshot(next);
      setError(null);
      setRevision((value) => value + 1);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not load groups');
    } finally {
      if (sequence === requestSequence.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    // Pick up organization edits made in another browser, using this server only.
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30000);
    window.addEventListener('focus', onFocus);
    return () => {
      requestSequence.current += 1;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const createGroup = useCallback(async (name: string) => {
    const group = await createConversationGroup(name);
    setSnapshot((current) => ({ ...current, groups: [...current.groups, group] }));
    await refresh();
    return group;
  }, [refresh]);

  const renameGroup = useCallback(async (id: string, name: string) => {
    const group = await renameConversationGroup(id, name);
    setSnapshot((current) => ({ ...current, groups: current.groups.map((item) => item.id === id ? group : item) }));
    await refresh();
  }, [refresh]);

  const deleteGroup = useCallback(async (id: string) => {
    await deleteConversationGroup(id);
    setSnapshot((current) => ({
      groups: current.groups.filter((group) => group.id !== id),
      memberships: Object.fromEntries(Object.entries(current.memberships).filter(([, groupId]) => groupId !== id)),
    }));
    await refresh();
  }, [refresh]);

  const assignSession = useCallback(async (sessionId: string, groupId: string | null) => {
    await assignConversationGroup(sessionId, groupId);
    setSnapshot((current) => {
      const memberships = { ...current.memberships };
      if (groupId === null) delete memberships[sessionId];
      else memberships[sessionId] = groupId;
      return { ...current, memberships };
    });
    await refresh();
  }, [refresh]);

  const openAssignment = useCallback((sessionId: string) => setDialog({ kind: 'assign', sessionId }), []);
  const openNewConversation = useCallback((groupId: string) => setDialog({ kind: 'new', groupId }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const value = useMemo(() => ({
    ...snapshot, isLoading, error, revision, dialog, refresh, createGroup, renameGroup, deleteGroup,
    assignSession, openAssignment, openNewConversation, closeDialog,
  }), [snapshot, isLoading, error, revision, dialog, refresh, createGroup, renameGroup, deleteGroup,
    assignSession, openAssignment, openNewConversation, closeDialog]);

  return <ConversationGroupsContext.Provider value={value}>{children}</ConversationGroupsContext.Provider>;
}
