import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { WorkspaceAgentReveal, WorkspaceAgentsSnapshot, WorkspacePanelTab } from '@/shared/types';

type PanelState = {
  open: boolean;
  maximized: boolean;
  tab: WorkspacePanelTab;
  visited: ReadonlySet<WorkspacePanelTab>;
  agents: WorkspaceAgentsSnapshot | null;
  agentReveal: WorkspaceAgentReveal | null;
  sideChatCount: number;
};
type PanelActions = {
  openPanel: (tab: WorkspacePanelTab) => void;
  collapsePanel: () => void;
  toggleMaximized: () => void;
  openAgent: (messageKey: string, toolId?: string) => void;
  publishAgents: (snapshot: WorkspaceAgentsSnapshot | null) => void;
  setSideChatCount: (count: number) => void;
};

const WorkspacePanelStateContext = createContext<PanelState | null>(null);
const WorkspacePanelActionsContext = createContext<PanelActions | null>(null);

/** Used by project-workspace to retain panel state while chat selection and views change. */
export function WorkspacePanelsProvider({ children }: { children: ReactNode }) {
  // Keep the selected view and visited views even while the panel is collapsed.
  const [panel, setPanel] = useState({ open: false, maximized: false, tab: 'files' as WorkspacePanelTab, visited: new Set<WorkspacePanelTab>() });
  // Hold the viewed chat's normalized agent records for the separate detail pane.
  const [agents, setAgents] = useState<WorkspaceAgentsSnapshot | null>(null);
  // Identify an exact agent/tool requested from a transcript or changes summary.
  const [agentReveal, setAgentReveal] = useState<WorkspaceAgentReveal | null>(null);
  // Make retained side chats reachable from the ordinary workspace view controls.
  const [sideChatCount, setSideChatCount] = useState(0);
  const requestSequence = useRef(0);
  const openPanel = useCallback((tab: WorkspacePanelTab) => {
    setPanel(current => ({ ...current, open: true, tab, visited: new Set(current.visited).add(tab) }));
  }, []);
  const collapsePanel = useCallback(() => setPanel(current => ({ ...current, open: false, maximized: false })), []);
  const toggleMaximized = useCallback(() => setPanel(current => ({ ...current, open: true, maximized: !current.maximized })), []);
  const openAgent = useCallback((messageKey: string, toolId?: string) => {
    setAgentReveal({ messageKey, toolId, requestId: ++requestSequence.current });
    openPanel('agents');
  }, [openPanel]);
  const actions = useMemo(() => ({ openPanel, collapsePanel, toggleMaximized, openAgent, publishAgents: setAgents, setSideChatCount }), [openPanel, collapsePanel, toggleMaximized, openAgent]);
  const state = useMemo(() => ({ ...panel, agents, agentReveal, sideChatCount }), [panel, agents, agentReveal, sideChatCount]);
  return <WorkspacePanelActionsContext.Provider value={actions}><WorkspacePanelStateContext.Provider value={state}>{children}</WorkspacePanelStateContext.Provider></WorkspacePanelActionsContext.Provider>;
}

/** Read panel navigation and agent data from project-workspace or the chat agent browser. */
export function useWorkspacePanels() { return useContext(WorkspacePanelStateContext); }

/** Stable commands let the live chat publish agents without subscribing to panel resize/navigation. */
export function useWorkspacePanelActions() { return useContext(WorkspacePanelActionsContext); }
