import { Bot, Folder, GitBranch, MonitorPlay, Settings, Terminal, Wrench } from 'lucide-react';

import type { WorkspaceNavigationState } from '@/shared/types';

type HubWorkspaceToolbarProps = {
  navigation?: WorkspaceNavigationState;
  machine: string;
  title: string;
  sidebarClosed: boolean;
  onSelect: (tab: string) => void;
  onSettings: () => void;
};

/** Keeps tools outside the drawer while a remote still serves the older workspace layout. */
export function HubWorkspaceToolbar({ navigation, machine, title, sidebarClosed, onSelect, onSettings }: HubWorkspaceToolbarProps) {
  const icons = { shell: Terminal, files: Folder, git: GitBranch, agents: Bot, browser: MonitorPlay };
  return <div className={`flex min-h-12 shrink-0 items-center gap-2 border-b border-border bg-background pr-2 ${sidebarClosed ? 'pl-14' : 'pl-3'}`} data-testid="hub-workspace-tools">
    <div className="hidden min-w-0 max-w-64 flex-1 sm:block">
      <div className="truncate text-sm font-medium" title={title}>{title}</div>
      <div className="truncate text-xs text-muted-foreground" title={machine}>{machine}</div>
    </div>
    <nav aria-label="工作区工具" className="scrollbar-hide ml-auto flex min-w-0 items-center gap-1 overflow-x-auto">
      {navigation?.tabs.filter(tab => tab.id !== 'chat' && tab.id !== 'preferences').map(tab => {
        const Icon = icons[tab.id as keyof typeof icons] ?? Wrench;
        return <button key={tab.id} type="button" aria-label={tab.label} aria-pressed={navigation.activeTab === tab.id} title={tab.label} onClick={() => onSelect(tab.id)} className={`flex h-11 min-w-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${navigation.activeTab === tab.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent'}`}><Icon className="h-4 w-4 shrink-0" /><span>{tab.label}</span></button>;
      })}
    </nav>
    <button type="button" aria-label={`${machine} 的设置`} title={`${machine} 的设置`} onClick={onSettings} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Settings className="h-4 w-4" /></button>
  </div>;
}
