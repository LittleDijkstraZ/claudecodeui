import { Bot, Folder, GitBranch, MonitorPlay, Terminal, Wrench } from 'lucide-react';

import { OverflowToolTabs } from '@/shared/ui';
import type { WorkspaceNavigationState } from '@/shared/types';

type HubWorkspaceToolbarProps = {
  navigation?: WorkspaceNavigationState;
  onSelect: (tab: string) => void;
};

/** Renders tools inside the hub's fallback drawer while a remote still serves the older workspace layout. */
export function HubWorkspaceToolbar({ navigation, onSelect }: HubWorkspaceToolbarProps) {
  const icons = { shell: Terminal, files: Folder, git: GitBranch, agents: Bot, browser: MonitorPlay };
  return <div className="flex min-h-12 min-w-0 shrink-0 items-center border-b border-border bg-background" data-testid="hub-workspace-tools">
    <div className="ml-auto min-w-0 flex-1"><OverflowToolTabs label="工作区工具" moreLabel="更多工具" activeTab={navigation?.activeTab ?? 'chat'} onSelect={id => onSelect(id === navigation?.activeTab ? 'chat' : id)}
      tabs={(navigation?.tabs ?? []).filter(tab => tab.id !== 'chat' && tab.id !== 'preferences').map(tab => {
        const Icon = icons[tab.id as keyof typeof icons] ?? Wrench;
        return { ...tab, icon: <Icon className="h-[18px] w-[18px] shrink-0" /> };
      })} /></div>
  </div>;
}
