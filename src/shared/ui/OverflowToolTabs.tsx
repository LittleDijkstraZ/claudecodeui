import { useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';

import { ActionMenu } from '@/shared/ui/ActionMenu';

type ToolTab = { id: string; label: string; icon: ReactNode };
type OverflowToolTabsProps = { tabs: ToolTab[]; activeTab: string; onSelect: (id: string) => void; label: string; moreLabel: string };
const TAB_CLASS = 'flex h-11 min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary';

/** Shared by the remote workspace and hub fallback; measured overflow stays reachable through More. */
export function OverflowToolTabs({ tabs, activeTab, onSelect, label, moreLabel }: OverflowToolTabsProps) {
  const root = useRef<HTMLDivElement>(null);
  const measures = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);
  const labels = JSON.stringify(tabs.map(tab => [tab.id, tab.label]));
  useLayoutEffect(() => {
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
  }, [labels]);
  const shown = tabs.slice(0, visibleCount);
  const overflow = tabs.slice(visibleCount);
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
  return <div ref={root} className="relative flex w-full min-w-0 items-center justify-end gap-1" data-testid="overflow-tool-tabs">
    <div aria-hidden="true" className="pointer-events-none invisible absolute inset-0 overflow-hidden"><div ref={measures} className="flex w-max gap-1">
      {tabs.map(tab => <span key={tab.id} className={TAB_CLASS}>{tab.icon}<span className="max-w-40 truncate">{tab.label}</span></span>)}
    </div></div>
    <div role="tablist" aria-label={label} className="flex min-w-0 items-center gap-1">
      {shown.map((tab, index) => <button key={tab.id} type="button" role="tab" title={tab.label} aria-label={tab.label} aria-selected={tab.id === activeTab}
        tabIndex={tab.id === activeTab || (!selectedVisible && index === 0) ? 0 : -1} onKeyDown={onKeyDown} onClick={() => onSelect(tab.id)}
        className={`${TAB_CLASS} ${tab.id === activeTab ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}>
        {tab.icon}<span className="max-w-40 truncate">{tab.label}</span>
      </button>)}
    </div>
    {overflow.length > 0 && <ActionMenu portal iconOnly icon={MoreHorizontal} variant="ghost" label={moreLabel} ariaLabel={selectedOverflow ? `${moreLabel} · ${selectedOverflow.label}` : moreLabel}
      className="shrink-0" triggerClassName={`h-11 min-h-11 w-11 min-w-11 p-0 ${selectedOverflow ? 'bg-accent text-accent-foreground' : ''}`} menuClassName="max-h-[75vh] max-w-[calc(100vw-16px)] overflow-y-auto"
      items={overflow.map(tab => ({ key: tab.id, label: tab.label, description: tab.id === activeTab ? '✓' : undefined, onSelect: () => onSelect(tab.id) }))} />}
  </div>;
}
