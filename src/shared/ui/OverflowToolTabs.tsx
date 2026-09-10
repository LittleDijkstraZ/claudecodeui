import { useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { MoreHorizontal, X } from 'lucide-react';

import { ActionMenu } from '@/shared/ui/ActionMenu';
import { useToolTabAppearance } from '@/shared/hooks/useToolTabAppearance';

type ToolTab = { id: string; label: string; icon: ReactNode; showLabel?: boolean; onClose?: () => void; closeLabel?: string };
type OverflowToolTabsProps = { tabs: ToolTab[]; activeTab: string; onSelect: (id: string) => void; label: string; moreLabel: string; scrollable?: boolean; trailing?: ReactNode };
const TAB_CLASS = 'flex h-11 min-h-11 items-center justify-center rounded-lg py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary';

/** Shared by the remote workspace and hub fallback; measured overflow stays reachable through More; dynamic workspace tabs can scroll with an add menu. */
export function OverflowToolTabs({ tabs, activeTab, onSelect, label, moreLabel, scrollable = false, trailing }: OverflowToolTabsProps) {
  const [appearance] = useToolTabAppearance();
  const showLabels = appearance === 'icons-and-text';
  const root = useRef<HTMLDivElement>(null);
  const measures = useRef<HTMLDivElement>(null);
  // Keep only the tools that fit; all remaining tools stay available in More.
  const [visibleCount, setVisibleCount] = useState(tabs.length);
  const labels = JSON.stringify(tabs.map(tab => [tab.id, tab.label]));
  useLayoutEffect(() => {
    if (scrollable) return;
    const container = root.current;
    const measurement = measures.current;
    if (!container || !measurement) return;
    const measure = () => {
      const available = container.clientWidth;
      if (!available) return; // A retained remote can be hidden without losing its navigation.
      const widths = Array.from(measurement.children, child => child.getBoundingClientRect().width);
      const sum = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * 4;
      if (sum <= available) { setVisibleCount(widths.length); return; }
      let used = 44; // The icon-only More trigger keeps its full click target even in a narrow pane.
      let count = 0;
      for (const width of widths) {
        if (used + width + 4 > available) break;
        used += width + 4; count++;
      }
      setVisibleCount(count);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container); observer?.observe(measurement);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [labels, appearance, scrollable]);
  useLayoutEffect(() => {
    if (!scrollable) return;
    const tablist = root.current?.querySelector('[role="tablist"]');
    if (!tablist) return;
    const revealSelection = () => tablist.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    revealSelection();
    // Resizing a drawer can push the selected tab beyond the minimum-width overflow.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealSelection);
    observer?.observe(tablist);
    return () => observer?.disconnect();
  }, [activeTab, labels, appearance, scrollable]);
  const shown = scrollable ? tabs : tabs.slice(0, visibleCount);
  const overflow = scrollable ? [] : tabs.slice(visibleCount);
  const selectedVisible = shown.some(tab => tab.id === activeTab);
  const selectedOverflow = overflow.find(tab => tab.id === activeTab);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
      : event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); buttons[next]?.focus();
    const tab = shown[next];
    if (tab && tab.id !== activeTab) onSelect(tab.id);
  };
  // Shrink closable labels before scrolling, but reserve their icon/close targets.
  // Only the tablist scrolls so the trailing add action never competes for that space.
  return <div ref={root} className="relative flex w-full min-w-0 items-center justify-start gap-1" data-testid="overflow-tool-tabs" data-appearance={appearance}>
    <div aria-hidden="true" className="pointer-events-none invisible absolute inset-0 overflow-hidden"><div ref={measures} className="flex w-max gap-1">
      {tabs.map(tab => <span key={tab.id} className={`${TAB_CLASS} min-w-11 shrink-0 gap-2 px-3`}>{tab.icon}{(showLabels || tab.showLabel) && <span className="max-w-40 truncate">{tab.label}</span>}</span>)}
    </div></div>
    <div role="tablist" aria-label={label} className={`flex items-center gap-1 ${scrollable ? 'scrollbar-hide min-w-0 flex-1 overflow-x-auto' : 'shrink-0'}`}>
      {shown.map((tab, index) => <div key={tab.id} className={`group relative ${scrollable && tab.onClose ? 'min-w-20 max-w-40 shrink' : 'shrink-0'}`}><button type="button" role="tab" title={tab.label} aria-label={tab.label} aria-selected={tab.id === activeTab}
        tabIndex={tab.id === activeTab || (!selectedVisible && index === 0) ? 0 : -1} onKeyDown={onKeyDown} onClick={() => onSelect(tab.id)}
        className={`${TAB_CLASS} ${scrollable && tab.onClose ? 'w-full min-w-0 gap-1 pl-2 pr-8' : `min-w-11 shrink-0 gap-2 pl-3 ${tab.onClose ? 'pr-9' : 'pr-3'}`} ${tab.id === activeTab ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}>
        <span aria-hidden="true" className="shrink-0">{tab.icon}</span>{(showLabels || tab.showLabel) && <span className="min-w-0 max-w-40 truncate">{tab.label}</span>}
      </button>
      {tab.onClose && <button type="button" aria-label={tab.closeLabel ?? `Close ${tab.label}`} title={tab.closeLabel ?? `Close ${tab.label}`} onClick={tab.onClose}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"><X className="h-3.5 w-3.5" /></button>}
      </div>)}
    </div>
    {trailing}
    {overflow.length > 0 && <ActionMenu portal iconOnly icon={MoreHorizontal} variant="ghost" label={moreLabel} ariaLabel={selectedOverflow ? `${moreLabel} · ${selectedOverflow.label}` : moreLabel}
      className="shrink-0" triggerClassName={`h-11 min-h-11 w-11 min-w-11 p-0 ${selectedOverflow ? 'bg-accent text-accent-foreground' : ''}`} menuClassName="max-h-[75vh] max-w-[calc(100vw-16px)] overflow-y-auto"
      items={overflow.map(tab => ({ key: tab.id, label: tab.label, description: tab.id === activeTab ? '✓' : undefined, onSelect: () => onSelect(tab.id) }))} />}
  </div>;
}
