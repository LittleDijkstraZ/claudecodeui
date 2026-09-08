import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Maximize2, Minimize2, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels/context/WorkspacePanelsContext';

const DEFAULT_WIDTH = 500;
const MIN_WIDTH = 300;
const MIN_MAIN_WIDTH = 320;

/** Used by project-workspace to give every right-hand view the same retained, resizable frame. */
export function WorkspacePanelLayout({ main, children, title, navigation, sessionId = null, mainCovered = false }: { main: ReactNode; children: ReactNode; title: string; navigation?: ReactNode; sessionId?: string | null; mainCovered?: boolean }) {
  const { t } = useTranslation('common');
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  const containerRef = useRef<HTMLDivElement>(null);
  // Measure the actual chat workspace, which may itself be inside a hub iframe.
  const [availableWidth, setAvailableWidth] = useState(0);
  // Retain the last chosen split width independently of maximize and collapse.
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cloudcli.workspace-panel-width'));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH;
  });
  // Shield sibling iframes during a drag so they cannot consume the pointer.
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; width: number } | null>(null);
  const narrow = availableWidth > 0 && availableWidth < 760;
  const effectiveWidth = Math.max(MIN_WIDTH, Math.min(width, availableWidth - MIN_MAIN_WIDTH));

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (element.clientWidth > 0) setAvailableWidth(element.clientWidth); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { localStorage.setItem('cloudcli.workspace-panel-width', String(width)); }, [width]);
  useEffect(() => {
    if (window.parent === window || !window.__CLOUDCLI_EMBEDDED__ || window.__CLOUDCLI_SIDE_CHAT__) return;
    window.parent.postMessage({ kind: 'cloudcli:chat-visibility', sessionId, visible: !mainCovered && !(panel?.open && (narrow || panel.maximized)) }, location.origin);
  }, [sessionId, mainCovered, panel?.open, panel?.maximized, narrow]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || narrow || panel?.maximized) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, width: effectiveWidth };
    setResizing(true);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWidth(Math.max(MIN_WIDTH, Math.min(availableWidth - MIN_MAIN_WIDTH, drag.width + drag.startX - event.clientX)));
  };
  const endResize = () => { dragRef.current = null; setResizing(false); };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setWidth(current => Math.max(MIN_WIDTH, Math.min(availableWidth - MIN_MAIN_WIDTH, current + (event.key === 'ArrowLeft' ? 32 : -32))));
  };

  return <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="workspace-panel-layout">
    <div className={`min-h-0 min-w-0 flex-1 ${panel?.open && (narrow || panel.maximized) ? 'hidden' : 'flex flex-col'}`} data-testid="workspace-main-chat">{main}</div>
    <aside
      aria-label={t('workspacePanel.title', { defaultValue: 'Workspace panel' })}
      hidden={!panel?.open}
      className={`${panel?.open ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden border-l border-border bg-background ${narrow || panel?.maximized ? 'absolute inset-0 z-30' : 'relative shrink-0'}`}
      style={narrow || panel?.maximized ? undefined : { width: effectiveWidth }}
      data-testid="workspace-right-panel"
    >
      {!narrow && !panel?.maximized && <div role="separator" aria-label={t('workspacePanel.resize', { defaultValue: 'Resize workspace panel' })} aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={Math.max(MIN_WIDTH, availableWidth - MIN_MAIN_WIDTH)} aria-valuenow={Math.round(effectiveWidth)} tabIndex={0} onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={keyResize} className="absolute inset-y-0 left-0 z-50 w-1.5 cursor-col-resize touch-none hover:bg-primary/60 focus-visible:bg-primary/60 focus-visible:outline-none" />}
      <div className="flex min-h-[52px] min-w-0 shrink-0 items-center gap-1 border-b border-border px-2" data-testid="workspace-panel-tools">
        <h2 className="sr-only">{title}</h2>
        <div className="min-w-0 flex-1">{navigation}</div>
        <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label={t(panel?.maximized ? 'workspacePanel.restore' : 'workspacePanel.maximize', { defaultValue: panel?.maximized ? 'Restore split view' : 'Maximize panel' })} title={t(panel?.maximized ? 'workspacePanel.restore' : 'workspacePanel.maximize', { defaultValue: panel?.maximized ? 'Restore split view' : 'Maximize panel' })} onClick={actions?.toggleMaximized}>{panel?.maximized ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}</Button>
        {!navigation && <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label={t('workspacePanel.collapse', { defaultValue: 'Collapse panel; keep work running' })} onClick={actions?.collapsePanel}><PanelRightClose className="h-5 w-5" /></Button>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </aside>
    {resizing && <div className="absolute inset-0 z-40 cursor-col-resize" aria-hidden />}
  </div>;
}
