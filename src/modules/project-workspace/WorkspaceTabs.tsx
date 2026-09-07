import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, Bot, MessagesSquare, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, WorkspacePanelTab } from '@/shared/types';
import { usePlugins, PluginIcon } from '@/modules/plugins';
import { useWorkspaceNavigationBridge } from '@/modules/project-workspace/hooks/useWorkspaceNavigationBridge';
import { useWorkspacePanels } from '@/modules/workspace-panels';

type WorkspaceTabsProps = {
  activeTab: AppTab | WorkspacePanelTab;
  sessionId?: string | null;
  onHubNavigationReady?: (sessionId: string | null) => void;
  setActiveTab: (tab: AppTab | WorkspacePanelTab) => void;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab | WorkspacePanelTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab | WorkspacePanelTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'preferences', labelKey: 'workspacePanel.preferences', icon: SlidersHorizontal },
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git', labelKey: 'workspacePanel.sourceControl', icon: GitBranch },
  { kind: 'builtin', id: 'agents', labelKey: 'workspacePanel.agents', icon: Bot },
];

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** Rendered inside the workspace drawer to keep built-in and enabled plugin tools reachable with large labeled controls. */
export default function WorkspaceTabs({
  activeTab,
  sessionId = null,
  onHubNavigationReady,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const panel = useWorkspacePanels();

  const builtInTabs: BuiltInTab[] = [
    ...BASE_TABS,
    ...(panel?.sideChatCount ? [{ kind: 'builtin' as const, id: 'sideChat' as const, labelKey: 'workspacePanel.sideChat', icon: MessagesSquare }] : []),
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  const navigationTabs = tabs.map(tab => ({ id: tab.id, label: tab.kind === 'builtin' ? t(tab.labelKey) : tab.label }));
  useWorkspaceNavigationBridge({ sessionId, activeTab, tabs: navigationTabs }, setActiveTab, onHubNavigationReady);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return <div role="tablist" aria-label={t('tabs.views', { defaultValue: 'Workspace views' })} className="scrollbar-hide flex items-center gap-1 overflow-x-auto overscroll-x-contain px-2 py-1" data-testid="workspace-tool-navigation">
    {tabs.map(tab => {
      const isActive = tab.id === activeTab;
      const label = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;
      return <button
        key={tab.id} type="button" role="tab" title={label} aria-label={label} aria-selected={isActive}
        tabIndex={isActive ? 0 : -1} onClick={() => setActiveTab(tab.id)} onKeyDown={handleTabKeyDown}
        className={`flex h-11 min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${isActive ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}
      >
        {tab.kind === 'builtin' ? <tab.icon className="h-[18px] w-[18px] shrink-0" /> : <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className="flex h-[18px] w-[18px] shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full" />}
        <span className={isActive ? 'max-w-40 truncate' : 'sr-only'}>{label}</span>
      </button>;
    })}
  </div>;
}
