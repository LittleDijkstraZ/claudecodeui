import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, Bot, MessagesSquare, type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '@/shared/ui';
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

/** Rendered by WorkspaceHeader to show the built-in workspace tabs plus any enabled plugin tabs. */
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

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInTabs.length && pluginTabs.length > 0 && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={displayLabel} position="bottom">
              <Pill
                role="tab"
                aria-label={displayLabel}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className="h-7 max-w-40 px-2 py-1"
              >
                {tab.kind === 'builtin' ? (
                  <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                ) : (
                  <PluginIcon
                    pluginName={tab.pluginName}
                    iconFile={tab.iconFile}
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                  />
                )}
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate sm:max-w-36 lg:inline`}>
                  {displayLabel}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}
