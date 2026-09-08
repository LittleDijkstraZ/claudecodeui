import { useId, useState } from 'react';
import { Plus, MessageCircle, Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, Bot, MessagesSquare, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AppTab, ProjectSession, WorkspacePanelTab } from '@/shared/types';
import { getSessionTitle } from '@/shared/utils';
import { usePlugins, PluginIcon } from '@/modules/plugins';
import { useWorkspaceNavigationBridge } from '@/modules/project-workspace/hooks/useWorkspaceNavigationBridge';
import { ActionMenu, Button, Dialog, DialogContent, DialogTitle, OverflowToolTabs } from '@/shared/ui';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';

type WorkspaceTabsProps = {
  activeTab: AppTab | WorkspacePanelTab;
  sessionId?: string | null;
  session?: ProjectSession | null;
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

/** Rendered by WorkspaceMain inside the retained right panel; Chat stays the primary surface. */
export default function WorkspaceTabs({
  activeTab,
  sessionId = null,
  session = null,
  onHubNavigationReady,
  setActiveTab,
  onNavigation,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  // Removal stays pending until the user confirms discarding this tab and its request.
  const [closingId, setClosingId] = useState<string | null>(null);
  const dialogId = useId();
  const closing = panel?.btwTabs.find(tab => tab.id === closingId);
  const canCreateBtw = Boolean(sessionId && session && (!session.__provider || session.__provider === 'claude'));

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

  const navigationTabs = [...tabs.map(tab => ({ id: tab.id, label: tab.kind === 'builtin' ? t(tab.labelKey) : tab.label })), ...(panel?.btwTabs ?? []).map(tab => ({ id: tab.id, label: tab.label }))];
  useWorkspaceNavigationBridge({ sessionId, activeTab, tabs: navigationTabs }, onNavigation ?? setActiveTab, onHubNavigationReady);

  return <div className="flex w-full min-w-0 px-1 py-1" data-testid="workspace-tool-navigation">
    <OverflowToolTabs scrollable activeTab={activeTab} onSelect={id => setActiveTab(id as AppTab | WorkspacePanelTab)} label={t('tabs.views', { defaultValue: 'Workspace views' })} moreLabel={t('buttons.more', { defaultValue: 'More tools' })}
      trailing={<ActionMenu portal iconOnly icon={Plus} variant="ghost" label={t('btw.addTab')} triggerClassName="h-11 w-11 p-0" className="sticky right-0 z-10 shrink-0 bg-background" items={[{ key: 'btw', label: t('btw.new'), icon: MessageCircle, disabled: !canCreateBtw, description: canCreateBtw ? undefined : t('btw.requiresClaude'), onSelect: () => { if (sessionId && session) actions?.createBtw(sessionId, getSessionTitle(session)); } }]} />}
      tabs={[...tabs.map(tab => ({ id: tab.id, label: tab.kind === 'builtin' ? t(tab.labelKey) : tab.label,
        icon: tab.kind === 'builtin' ? <tab.icon className="h-[18px] w-[18px] shrink-0" /> : <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className="flex h-[18px] w-[18px] shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full" />,
      })), ...(panel?.btwTabs ?? []).map(tab => ({ id: tab.id, label: tab.label, icon: <MessageCircle className="h-[18px] w-[18px]" />, showLabel: true, onClose: () => setClosingId(tab.id), closeLabel: t('btw.closeTab', { title: tab.label }) }))]} />
    <Dialog open={Boolean(closing)} onOpenChange={open => { if (!open) setClosingId(null); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-sm p-5" aria-labelledby={`${dialogId}-title`} aria-describedby={`${dialogId}-description`}>
        <DialogTitle id={`${dialogId}-title`} className="not-sr-only text-base font-semibold">{t('btw.closeTitle')}</DialogTitle>
        <p id={`${dialogId}-description`} className="mt-2 text-sm text-muted-foreground">{t('btw.closeDescription', { title: closing?.label })}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setClosingId(null)}>{t('btw.cancel')}</Button>
          <Button variant="destructive" onClick={() => { if (closingId) actions?.closeBtw(closingId); setClosingId(null); }}>{t('btw.confirmClose')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
