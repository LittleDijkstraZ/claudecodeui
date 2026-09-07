import { Activity, Archive } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

type SidebarViewSwitcherProps = {
  mode: SidebarSearchMode;
  onChange: (mode: SidebarSearchMode) => void;
  runningCount: number;
  t: TFunction;
};

/** Shared by the desktop and mobile headers so all browsing modes stay reachable. */
export default function SidebarViewSwitcher({ mode, onChange, runningCount, t }: SidebarViewSwitcherProps) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted/50 p-0.5" role="group" aria-label={t('groups.browseViews')}>
        {(['projects', 'conversations', 'groups'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onChange(value)}
            className={cn(
              'min-w-0 rounded-md px-1 py-2 text-[11px] font-normal transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(value === 'projects' ? 'search.modeProjects' : value === 'conversations' ? 'search.modeConversations' : 'search.modeGroups')}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange('running')}
          aria-pressed={mode === 'running'}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            mode === 'running' ? 'bg-emerald-500/10 text-foreground' : 'text-muted-foreground hover:bg-accent/60',
          )}
        >
          <Activity className={cn('h-3 w-3', runningCount > 0 && 'text-emerald-500')} />
          {t('groups.running')}
          {runningCount > 0 && <span className="rounded-full bg-emerald-500/15 px-1 text-[10px] tabular-nums">{runningCount > 99 ? '99+' : runningCount}</span>}
        </button>
        <button
          type="button"
          onClick={() => onChange('archived')}
          aria-pressed={mode === 'archived'}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            mode === 'archived' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60',
          )}
        >
          <Archive className="h-3 w-3" />{t('groups.archive')}
        </button>
      </div>
    </div>
  );
}
