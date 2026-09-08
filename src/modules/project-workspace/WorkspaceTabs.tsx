import { Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, Bot, MessagesSquare, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AppTab, WorkspacePanelTab } from '@/shared/types';
import { usePlugins, PluginIcon } from '@/modules/plugins';
import { useWorkspaceNavigationBridge } from '@/modules/project-workspace/hooks/useWorkspaceNavigationBridge';
import { OverflowToolTabs } from '@/shared/ui';
import { useWorkspacePanels } from '@/modules/workspace-panels';

type WorkspaceTabsProps = {
  activeTab: AppTab | WorkspacePanelTab;
  sessionId?: string | null;
  onHubNavigationReady?: (sessionId: string | null) => void;
  setActiveTab: (tab: AppTab | WorkspacePanelTab) => void;
  onNavigation?: (tab: AppTab | WorkspacePanelTab) => void;
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

/** Rendered by WorkspaceMain outside the collapsible panel so tools remain reachable beside the persistent chat. */
export default function WorkspaceTabs({
  activeTab,
  sessionId = null,
  onHubNavigationReady,
  setActiveTab,
  onNavigation,
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
  useWorkspaceNavigationBridge({ sessionId, activeTab, tabs: navigationTabs }, onNavigation ?? setActiveTab, onHubNavigationReady);

  return <div className="flex w-full min-w-0 px-1 py-1" data-testid="workspace-tool-navigation">
    <OverflowToolTabs activeTab={activeTab} onSelect={id => setActiveTab(id as AppTab | WorkspacePanelTab)} label={t('tabs.views', { defaultValue: 'Workspace views' })} moreLabel={t('buttons.more', { defaultValue: 'More tools' })}
      tabs={tabs.map(tab => ({ id: tab.id, label: tab.kind === 'builtin' ? t(tab.labelKey) : tab.label,
        icon: tab.kind === 'builtin' ? <tab.icon className="h-[18px] w-[18px] shrink-0" /> : <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className="flex h-[18px] w-[18px] shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full" />,
      }))} />
  </div>;
}
