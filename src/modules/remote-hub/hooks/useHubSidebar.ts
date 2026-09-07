import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 220;
const MAX_WIDTH = 560;
const MIN_CHAT_WIDTH = 360;
const OVERLAY_BREAKPOINT = 760;

/** Used by the remote hub to retain an adjustable sidebar without remounting remote workspaces. */
export function useHubSidebar() {
  const containerRef = useRef<HTMLDivElement>(null);
  // Measure the whole local workspace so a split browser window also constrains the sidebar.
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth);
  // Restore the user's sidebar size independently of temporary narrow-window clamping.
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('cloudcli.hub-sidebar-width'));
      return Number.isFinite(stored) && stored >= MIN_WIDTH ? Math.min(stored, MAX_WIDTH) : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  // Opening or closing a sidebar changes only local presentation, never a remote iframe's lifetime.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const stored = localStorage.getItem('cloudcli.hub-sidebar-open');
      return stored === null ? window.innerWidth >= OVERLAY_BREAKPOINT : stored === 'true';
    } catch { return true; }
  });
  // Shield iframe contents while a pointer drag owns the local resize handle.
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ id: number; x: number; width: number } | null>(null);
  const narrow = availableWidth < OVERLAY_BREAKPOINT;
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth - MIN_CHAT_WIDTH));
  const width = narrow ? Math.min(preferredWidth, Math.max(0, availableWidth - 44)) : Math.max(MIN_WIDTH, Math.min(preferredWidth, maxWidth));

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setAvailableWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem('cloudcli.hub-sidebar-width', String(preferredWidth)); } catch { /* Keep the in-memory preference. */ } }, [preferredWidth]);
  useEffect(() => { try { localStorage.setItem('cloudcli.hub-sidebar-open', String(sidebarOpen)); } catch { /* Keep the in-memory preference. */ } }, [sidebarOpen]);
  const endResize = useCallback(() => { dragRef.current = null; setResizing(false); }, []);
  useEffect(() => { if (narrow || !sidebarOpen) endResize(); }, [narrow, sidebarOpen, endResize]);
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || narrow) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, width };
    setResizing(true);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    setPreferredWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, drag.width + event.clientX - drag.x)));
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setPreferredWidth(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth
      : Math.max(MIN_WIDTH, Math.min(maxWidth, width + (event.key === 'ArrowRight' ? 24 : -24))));
  };
  return { containerRef, sidebarOpen, setSidebarOpen, width, maxWidth, minWidth: MIN_WIDTH, narrow, resizing, beginResize, moveResize, endResize, keyResize };
}
