import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { WorkspaceBtwTab, WorkspaceAgentReveal, WorkspaceAgentsSnapshot, WorkspacePanelTab } from '@/shared/types';

type PanelState = {
  open: boolean;
  maximized: boolean;
  tab: WorkspacePanelTab;
  visited: ReadonlySet<WorkspacePanelTab>;
  agents: WorkspaceAgentsSnapshot | null;
  agentReveal: WorkspaceAgentReveal | null;
  sideChatCount: number;
  activeSessionId: string | null;
  btwTabs: WorkspaceBtwTab[];
  terminalReveal: { sessionId: string; executionId?: string; providerSessionId?: string; requestId: number } | null;
};
type PanelActions = {
  openPanel: (tab: WorkspacePanelTab) => void;
  revealTerminal: (target: { sessionId: string; executionId?: string; providerSessionId?: string }) => void;
  togglePanel: (tab: WorkspacePanelTab) => void;
  setPanelOpen: (open: boolean) => void;
  collapsePanel: () => void;
  toggleMaximized: () => void;
  openAgent: (messageKey: string, toolId?: string) => void;
  publishAgents: (snapshot: WorkspaceAgentsSnapshot | null) => void;
  setSideChatCount: (count: number) => void;
  createBtw: (sessionId: string, sourceLabel: string) => void;
  closeBtw: (id: string) => void;
  renameBtw: (id: string, label: string) => void;
};

const WorkspacePanelStateContext = createContext<PanelState | null>(null);
const WorkspacePanelActionsContext = createContext<PanelActions | null>(null);

type PanelNavigation = Pick<PanelState, 'open' | 'maximized' | 'tab'>;
type RetainedPanels = PanelNavigation & {
  visited: Set<WorkspacePanelTab>;
  btwTabs: WorkspaceBtwTab[];
  btwViews: Record<string, PanelNavigation>;
};

function navigationForSession(panel: RetainedPanels, sessionId: string | null): PanelNavigation {
  return (sessionId && panel.btwViews[sessionId]) || { open: panel.open, maximized: panel.maximized, tab: panel.tab };
}

function retainNavigation(panel: RetainedPanels, sessionId: string | null, navigation: PanelNavigation): RetainedPanels {
  if (navigation.tab.startsWith('btw:')) {
    if (!sessionId || !panel.btwTabs.some(tab => tab.id === navigation.tab && tab.sessionId === sessionId)) return panel;
    return { ...panel, btwViews: { ...panel.btwViews, [sessionId]: navigation } };
  }
  const btwViews = { ...panel.btwViews };
  if (sessionId) delete btwViews[sessionId];
  return { ...panel, ...navigation, btwViews };
}

/** Used by project-workspace to retain panel state while chat selection and views change. */
export function WorkspacePanelsProvider({ children, activeSessionId = null }: { children: ReactNode; activeSessionId?: string | null }) {
  // Retain all mounted views, with each conversation's BTW selection separate from shared tools.
  const [panel, setPanel] = useState<RetainedPanels>({ open: false, maximized: false, tab: 'preferences', visited: new Set(), btwTabs: [], btwViews: {} });
  // Hold the viewed chat's normalized agent records for the separate detail pane.
  const [agents, setAgents] = useState<WorkspaceAgentsSnapshot | null>(null);
  // Identify an exact agent/tool requested from a transcript or changes summary.
  const [agentReveal, setAgentReveal] = useState<WorkspaceAgentReveal | null>(null);
  // Make retained side chats reachable from the ordinary workspace view controls.
  const [sideChatCount, setSideChatCount] = useState(0);
  const requestSequence = useRef(0);
  // Retain explicit terminal reveal requests until their owning view consumes them.
  const [terminalReveal, setTerminalReveal] = useState<PanelState['terminalReveal']>(null);
  const openPanel = useCallback((tab: WorkspacePanelTab) => {
    setPanel(current => {
      const { maximized } = navigationForSession(current, activeSessionId);
      const next = retainNavigation(current, activeSessionId, { open: true, maximized, tab });
      return next === current ? current : { ...next, visited: new Set(current.visited).add(tab) };
    });
  }, [activeSessionId]);
  const togglePanel = openPanel;
  const collapsePanel = useCallback(() => setPanel(current => retainNavigation(current, activeSessionId, {
    ...navigationForSession(current, activeSessionId), open: false, maximized: false,
  })), [activeSessionId]);
  const setPanelOpen = useCallback((open: boolean) => setPanel(current => {
    const navigation = navigationForSession(current, activeSessionId);
    if (navigation.open === open) return current;
    const next = retainNavigation(current, activeSessionId, { ...navigation, open, maximized: open && navigation.maximized });
    return { ...next, visited: open ? new Set(current.visited).add(navigation.tab) : current.visited };
  }), [activeSessionId]);
  const toggleMaximized = useCallback(() => setPanel(current => {
    const navigation = navigationForSession(current, activeSessionId);
    return retainNavigation(current, activeSessionId, { ...navigation, open: true, maximized: !navigation.maximized });
  }), [activeSessionId]);
  const openAgent = useCallback((messageKey: string, toolId?: string) => {
    setAgentReveal({ messageKey, toolId, requestId: ++requestSequence.current });
    openPanel('agents');
  }, [openPanel]);
  const revealTerminal = useCallback((target: { sessionId: string; executionId?: string; providerSessionId?: string }) => {
    setTerminalReveal({ ...target, requestId: ++requestSequence.current });
    openPanel('shell');
  }, [openPanel]);
  const btwSequence = useRef(0);
  const createBtw = useCallback((sessionId: string, sourceLabel: string) => {
    if (sessionId !== activeSessionId) return;
    const entry: WorkspaceBtwTab = { id: `btw:${crypto.randomUUID()}`, sessionId, sourceLabel, label: `BTW ${++btwSequence.current}` };
    setPanel(current => retainNavigation({ ...current, btwTabs: [...current.btwTabs, entry], visited: new Set(current.visited).add(entry.id) }, sessionId, {
      open: true, maximized: navigationForSession(current, sessionId).maximized, tab: entry.id,
    }));
  }, [activeSessionId]);
  const renameBtw = useCallback((id: string, label: string) => {
    setPanel(current => ({ ...current, btwTabs: current.btwTabs.map(tab => tab.id === id ? { ...tab, label } : tab) }));
  }, []);
  const closeBtw = useCallback((id: string) => {
    setPanel(current => {
      const owner = current.btwTabs.find(tab => tab.id === id)?.sessionId;
      if (!owner) return current;
      const siblings = current.btwTabs.filter(tab => tab.sessionId === owner);
      const index = siblings.findIndex(tab => tab.id === id);
      if (index < 0) return current;
      const btwTabs = current.btwTabs.filter(tab => tab.id !== id);
      const visited = new Set(current.visited); visited.delete(id as WorkspacePanelTab);
      const navigation = current.btwViews[owner];
      if (navigation?.tab !== id) return { ...current, btwTabs, visited };
      const remaining = siblings.filter(tab => tab.id !== id);
      const tab = remaining[Math.min(index, remaining.length - 1)]?.id
        ?? [...visited].filter(tab => !tab.startsWith('btw:')).at(-1) ?? 'shell';
      visited.add(tab);
      return retainNavigation({ ...current, btwTabs, visited }, owner, { ...navigation, tab });
    });
  }, []);
  const actions = useMemo(() => ({ createBtw, closeBtw, renameBtw, openPanel, revealTerminal, togglePanel, setPanelOpen, collapsePanel, toggleMaximized, openAgent, publishAgents: setAgents, setSideChatCount }), [createBtw, closeBtw, renameBtw, openPanel, revealTerminal, togglePanel, setPanelOpen, collapsePanel, toggleMaximized, openAgent]);
  const state = useMemo(() => {
    const { open, maximized, tab } = navigationForSession(panel, activeSessionId);
    return { open, maximized, tab, visited: panel.visited, btwTabs: panel.btwTabs, activeSessionId, agents, agentReveal, sideChatCount, terminalReveal };
  }, [panel, activeSessionId, agents, agentReveal, sideChatCount, terminalReveal]);
  return <WorkspacePanelActionsContext.Provider value={actions}><WorkspacePanelStateContext.Provider value={state}>{children}</WorkspacePanelStateContext.Provider></WorkspacePanelActionsContext.Provider>;
}

/** Read panel navigation and agent data from project-workspace or the chat agent browser. */
export function useWorkspacePanels() { return useContext(WorkspacePanelStateContext); }

/** Stable commands let the live chat publish agents without subscribing to panel resize/navigation. */
export function useWorkspacePanelActions() { return useContext(WorkspacePanelActionsContext); }
