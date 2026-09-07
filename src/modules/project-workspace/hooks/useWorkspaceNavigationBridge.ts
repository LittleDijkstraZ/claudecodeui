import { useEffect } from 'react';

import type { AppTab, WorkspaceNavigationState, WorkspacePanelTab } from '@/shared/types';

/** Mirrors actual enabled workspace views into the owning Hub and validates its view commands. */
export function useWorkspaceNavigationBridge(
  navigation: WorkspaceNavigationState,
  selectTab: (tab: AppTab | WorkspacePanelTab) => void,
  onReady?: (sessionId: string | null) => void,
) {
  const { sessionId, activeTab, tabs } = navigation;
  const serializedTabs = JSON.stringify(tabs);
  useEffect(() => {
    if (window.parent === window || !window.__CLOUDCLI_EMBEDDED__ || window.__CLOUDCLI_SIDE_CHAT__) return;
    const availableTabs: WorkspaceNavigationState['tabs'] = JSON.parse(serializedTabs);
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.sessionId !== sessionId) return;
      if (event.data.kind === 'cloudcli:workspace-nav-ready') onReady?.(sessionId);
      // Older hubs use chat to collapse a tool; the main chat no longer needs a visible tab.
      if (event.data.kind === 'cloudcli:workspace-tab' && (event.data.tab === 'chat' || availableTabs.some(tab => tab.id === event.data.tab))) selectTab(event.data.tab);
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ kind: 'cloudcli:workspace-nav', sessionId, activeTab, tabs: availableTabs }, location.origin);
    return () => window.removeEventListener('message', receive);
  }, [sessionId, activeTab, serializedTabs, selectTab, onReady]);
}
