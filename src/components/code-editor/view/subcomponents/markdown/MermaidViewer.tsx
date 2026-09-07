import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Expand, Maximize, Minimize, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';

import {
  centerDiagram,
  diagramSizeFromSvg,
  fitDiagram,
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  pinchDiagram,
  zoomDiagramAt,
  type DiagramPoint,
  type DiagramSize,
  type DiagramTransform,
} from './mermaidViewport';

type MermaidViewerProps = {
  /** Only the SVG returned by the existing strict Mermaid renderer. */
  svg: string;
  onClose: () => void;
};

/** The same generated SVG is inspected locally; opening a diagram does not render it again. */
export default function MermaidViewer({ svg, onClose }: MermaidViewerProps) {
  const { t } = useTranslation('codeEditor');
  const titleId = useId();
  const instructionsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointersRef = useRef(new Map<number, DiagramPoint>());
  const viewportSizeRef = useRef<DiagramSize>({ width: 1, height: 1 });
  const diagramSizeRef = useRef<DiagramSize>({ width: 1, height: 1 });
  const autoFitRef = useRef(true);
  const transformRef = useRef<DiagramTransform>({ x: 0, y: 0, scale: 1 });
  const [transform, setTransform] = useState(transformRef.current);
  const [isDragging, setIsDragging] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const updateTransform = useCallback((next: DiagramTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const fit = useCallback(() => {
    autoFitRef.current = true;
    updateTransform(fitDiagram(diagramSizeRef.current, viewportSizeRef.current));
  }, [updateTransform]);

  const reset = useCallback(() => {
    autoFitRef.current = false;
    updateTransform(centerDiagram(diagramSizeRef.current, viewportSizeRef.current, 1));
  }, [updateTransform]);

  const zoom = useCallback((factor: number, anchor?: DiagramPoint) => {
    autoFitRef.current = false;
    const viewport = viewportSizeRef.current;
    updateTransform(zoomDiagramAt(transformRef.current, transformRef.current.scale * factor, anchor ?? {
      x: viewport.width / 2, y: viewport.height / 2,
    }));
  }, [updateTransform]);

  const close = useCallback(() => {
    if (document.fullscreenElement === dialogRef.current && document.exitFullscreen) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose]);

  const toggleFullscreen = useCallback(async () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isMaximized) {
      setIsMaximized(false);
      if (document.fullscreenElement === dialog && document.exitFullscreen) {
        await document.exitFullscreen().catch(() => undefined);
      }
      return;
    }
    setIsMaximized(true);
    if (dialog.requestFullscreen) {
      // Some embedded/mobile browsers disallow fullscreen. The CSS viewport view
      // still expands immediately and remains usable when the request is denied.
      await dialog.requestFullscreen().catch(() => undefined);
    }
  }, [isMaximized]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const renderedSvg = diagramRef.current?.querySelector('svg');
    if (!viewport || !renderedSvg) return;
    const size = diagramSizeFromSvg(renderedSvg);
    diagramSizeRef.current = size;
    // Mermaid often sets width="100%" and max-width; use its native viewBox here.
    renderedSvg.style.width = `${size.width}px`;
    renderedSvg.style.height = `${size.height}px`;
    renderedSvg.style.maxWidth = 'none';
    renderedSvg.setAttribute('focusable', 'false');
    const resize = () => {
      viewportSizeRef.current = { width: viewport.clientWidth, height: viewport.clientHeight };
      if (autoFitRef.current) fit();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit, svg]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY * multiplier)) * 0.005), {
        x: event.clientX - bounds.left, y: event.clientY - bounds.top,
      });
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [zoom]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const fullscreenChange = () => {
      if (!document.fullscreenElement) setIsMaximized(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') zoom(1.25);
      else if (event.key === '-') zoom(1 / 1.25);
      else if (event.key === '0') reset();
      else if (event.key.toLowerCase() === 'f') fit();
      else if (event.key.startsWith('Arrow') && document.activeElement === viewportRef.current) {
        autoFitRef.current = false;
        const delta = event.shiftKey ? 100 : 40;
        const current = transformRef.current;
        updateTransform({
          ...current,
          x: current.x + (event.key === 'ArrowLeft' ? delta : event.key === 'ArrowRight' ? -delta : 0),
          y: current.y + (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0),
        });
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('fullscreenchange', fullscreenChange);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('fullscreenchange', fullscreenChange);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [close, fit, reset, updateTransform, zoom]);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point(event));
    autoFitRef.current = false;
    setIsDragging(true);
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const previousPoint = pointers.get(event.pointerId);
    if (!previousPoint) return;
    const before = [...pointers.values()];
    const next = point(event);
    pointers.set(event.pointerId, next);
    if (pointers.size === 1) {
      const current = transformRef.current;
      updateTransform({ ...current, x: current.x + next.x - previousPoint.x, y: current.y + next.y - previousPoint.y });
    } else if (pointers.size === 2) {
      updateTransform(pinchDiagram(transformRef.current, before as [DiagramPoint, DiagramPoint], [...pointers.values()] as [DiagramPoint, DiagramPoint]));
    }
  };

  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    setIsDragging(pointersRef.current.size > 0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const iconButtonClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40';

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={instructionsId}
        className={`flex flex-col overflow-hidden border border-border bg-background text-foreground shadow-2xl ${isMaximized ? 'h-dvh w-screen' : 'h-[92dvh] w-[96vw] rounded-xl sm:h-[90dvh] sm:w-[94vw]'}`}
        data-testid="mermaid-viewer"
      >
        <header className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-2 sm:gap-2 sm:px-4">
          <h2 id={titleId} className="mr-auto hidden text-sm font-medium sm:block">{t('mermaid.title')}</h2>
          <button type="button" aria-label={t('mermaid.zoomOut')} title={t('mermaid.zoomOut')} className={iconButtonClass} disabled={transform.scale <= MIN_DIAGRAM_SCALE} onClick={() => zoom(1 / 1.25)}><ZoomOut className="h-4 w-4" /></button>
          <span className="w-12 text-center text-xs tabular-nums" aria-label={t('mermaid.zoomLevel')}>{Math.round(transform.scale * 100)}%</span>
          <button type="button" aria-label={t('mermaid.zoomIn')} title={t('mermaid.zoomIn')} className={iconButtonClass} disabled={transform.scale >= MAX_DIAGRAM_SCALE} onClick={() => zoom(1.25)}><ZoomIn className="h-4 w-4" /></button>
          <span className="mx-1 h-5 border-l border-border" />
          <button type="button" aria-label={t('mermaid.fit')} title={t('mermaid.fit')} className={iconButtonClass} onClick={fit}><Expand className="h-4 w-4" /></button>
          <button type="button" aria-label={t('mermaid.reset')} title={t('mermaid.reset')} className={iconButtonClass} onClick={reset}><RotateCcw className="h-4 w-4" /></button>
          <button type="button" aria-label={t(isMaximized ? 'actions.exitFullscreen' : 'actions.fullscreen')} title={t(isMaximized ? 'actions.exitFullscreen' : 'actions.fullscreen')} className={iconButtonClass} onClick={() => void toggleFullscreen()}>{isMaximized ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</button>
          <button ref={closeRef} type="button" aria-label={t('mermaid.close')} title={t('mermaid.close')} className={`${iconButtonClass} ml-auto sm:ml-1`} onClick={close}><X className="h-5 w-5" /></button>
        </header>
        <div
          ref={viewportRef}
          tabIndex={0}
          aria-label={t('mermaid.canvas')}
          className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary dark:bg-zinc-900 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerEnd}
          onPointerCancel={pointerEnd}
          onLostPointerCapture={pointerEnd}
          onDoubleClick={fit}
          data-testid="mermaid-viewport"
        >
          <div
            ref={diagramRef}
            className="pointer-events-none absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
            dangerouslySetInnerHTML={{ __html: svg }}
            data-testid="mermaid-viewport-diagram"
          />
        </div>
        <p id={instructionsId} className="border-t border-border px-3 py-2 text-center text-xs text-muted-foreground">{t('mermaid.instructions')}</p>
      </div>
    </div>,
    document.body,
  );
}
