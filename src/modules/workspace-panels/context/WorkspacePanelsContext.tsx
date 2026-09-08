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

/** Used by project-workspace to retain panel state while chat selection and views change. */
export function WorkspacePanelsProvider({ children }: { children: ReactNode }) {
  // Keep the selected view and visited views even while the panel is collapsed.
  const [panel, setPanel] = useState({ open: false, maximized: false, tab: 'preferences' as WorkspacePanelTab, visited: new Set<WorkspacePanelTab>(), btwTabs: [] as WorkspaceBtwTab[] });
  // Hold the viewed chat's normalized agent records for the separate detail pane.
  const [agents, setAgents] = useState<WorkspaceAgentsSnapshot | null>(null);
  // Identify an exact agent/tool requested from a transcript or changes summary.
  const [agentReveal, setAgentReveal] = useState<WorkspaceAgentReveal | null>(null);
  // Make retained side chats reachable from the ordinary workspace view controls.
  const [sideChatCount, setSideChatCount] = useState(0);
  const requestSequence = useRef(0);
  const [terminalReveal, setTerminalReveal] = useState<PanelState['terminalReveal']>(null);
  const openPanel = useCallback((tab: WorkspacePanelTab) => {
    setPanel(current => ({ ...current, open: true, tab, visited: new Set(current.visited).add(tab) }));
  }, []);
  const togglePanel = useCallback((tab: WorkspacePanelTab) => {
    setPanel(current => ({ ...current, open: true, tab, visited: new Set(current.visited).add(tab) }));
  }, []);
  const collapsePanel = useCallback(() => setPanel(current => ({ ...current, open: false, maximized: false })), []);
  const setPanelOpen = useCallback((open: boolean) => setPanel(current => current.open === open ? current : {
    ...current, open, maximized: open && current.maximized,
    visited: open ? new Set(current.visited).add(current.tab) : current.visited,
  }), []);
  const toggleMaximized = useCallback(() => setPanel(current => ({ ...current, open: true, maximized: !current.maximized })), []);
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
    const entry: WorkspaceBtwTab = { id: `btw:${crypto.randomUUID()}`, sessionId, sourceLabel, label: `BTW ${++btwSequence.current}` };
    setPanel(current => ({ ...current, open: true, tab: entry.id, btwTabs: [...current.btwTabs, entry], visited: new Set(current.visited).add(entry.id) }));
  }, []);
  const renameBtw = useCallback((id: string, label: string) => {
    setPanel(current => ({ ...current, btwTabs: current.btwTabs.map(tab => tab.id === id ? { ...tab, label } : tab) }));
  }, []);
  const closeBtw = useCallback((id: string) => {
    setPanel(current => {
      const index = current.btwTabs.findIndex(tab => tab.id === id);
      if (index < 0) return current;
      const btwTabs = current.btwTabs.filter(tab => tab.id !== id);
      const visited = new Set(current.visited); visited.delete(id as WorkspacePanelTab);
      const adjacent = btwTabs[Math.min(index, btwTabs.length - 1)]?.id
        ?? [...visited].filter(tab => !tab.startsWith('btw:')).at(-1) ?? 'shell';
      const tab = current.tab === id ? adjacent : current.tab;
      visited.add(tab);
      return { ...current, btwTabs, visited, tab };
    });
  }, []);
  const actions = useMemo(() => ({ createBtw, closeBtw, renameBtw, openPanel, revealTerminal, togglePanel, setPanelOpen, collapsePanel, toggleMaximized, openAgent, publishAgents: setAgents, setSideChatCount }), [createBtw, closeBtw, renameBtw, openPanel, revealTerminal, togglePanel, setPanelOpen, collapsePanel, toggleMaximized, openAgent]);
  const state = useMemo(() => ({ ...panel, agents, agentReveal, sideChatCount, terminalReveal }), [panel, agents, agentReveal, sideChatCount, terminalReveal]);
  return <WorkspacePanelActionsContext.Provider value={actions}><WorkspacePanelStateContext.Provider value={state}>{children}</WorkspacePanelStateContext.Provider></WorkspacePanelActionsContext.Provider>;
}

/** Read panel navigation and agent data from project-workspace or the chat agent browser. */
export function useWorkspacePanels() { return useContext(WorkspacePanelStateContext); }

/** Stable commands let the live chat publish agents without subscribing to panel resize/navigation. */
export function useWorkspacePanelActions() { return useContext(WorkspacePanelActionsContext); }
