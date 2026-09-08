import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react';

import {
  canStartGroupDrag,
  createGroupDragSession,
  getGroupDragScrollDelta,
  getGroupDropTarget,
} from '@/modules/sidebar/utils/conversationGroupDrag';
import type { GroupDragPoint, GroupDragSource, GroupDropTarget } from '@/shared/types';

type DragOptions = {
  onMove: (groupId: string, sessionId: string, targetSessionId: string, position: 'before' | 'after') => Promise<void>;
  disabled?: boolean;
  onError?: (error: unknown) => void;
  /** Hub group headings share pointer handling but use their own DOM identity and pinned scope. */
  targetSelector?: string;
  targetIdentity?: (element: HTMLElement) => GroupDragSource;
};

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return element.ownerDocument.scrollingElement as HTMLElement | null;
}

export function useConversationGroupDrag(options: DragOptions) {
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const mounted = useRef(true);
  const moving = useRef(false);
  const cleanupDrag = useRef<(() => void) | null>(null);
  const cleanupClick = useRef<(() => void) | null>(null);
  // Highlight the source row only after the pointer crosses the deliberate drag threshold.
  const [dragState, setDragState] = useState<GroupDragSource | null>(null);
  // Draw a before-or-after marker for the currently valid destination row.
  const [dropTarget, setDropTarget] = useState<GroupDropTarget | null>(null);
  // Disable overlapping reorders until the saved move finishes.
  const [isMoving, setIsMoving] = useState(false);

  const cancelDrag = useCallback(() => cleanupDrag.current?.(), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanupDrag.current?.();
      cleanupClick.current?.();
    };
  }, []);

  useEffect(() => {
    if (options.disabled) cancelDrag();
  }, [cancelDrag, options.disabled]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>, source: GroupDragSource, isHandle: boolean) => {
    const element = event.currentTarget;
    const target = event.target as Element;
    if (latestOptions.current.disabled || moving.current || !canStartGroupDrag({
      button: event.button,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      isHandle,
      isInteractiveTarget: Boolean(target.closest('button, input, textarea, select, [contenteditable="true"], [role="menuitem"], [data-drag-ignore]')),
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    })) return;
    if (isHandle) event.stopPropagation();
    cancelDrag();
    cleanupClick.current?.();

    const doc = element.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;
    const pointerId = event.pointerId;
    let point: GroupDragPoint = { x: event.clientX, y: event.clientY };
    const session = createGroupDragSession(source, point);
    const scrollContainer = findScrollContainer(element);
    let frame = 0;
    let captured = false;
    let stopped = false;
    let lastDropKey = '';

    const hitTarget = () => {
      const config = latestOptions.current;
      const row = doc.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(config.targetSelector ?? '[data-session-id][data-group-id]');
      const bounds = row?.getBoundingClientRect();
      return getGroupDropTarget(source, row && bounds ? {
        ...(config.targetIdentity?.(row) ?? { groupId: row.dataset.groupId ?? '', sessionId: row.dataset.sessionId ?? '' }),
        top: bounds.top,
        height: bounds.height,
      } : null, point.y);
    };

    // A pointerup can still synthesize a click on an anchor even after capture
    // was released. Consume just that pointer click, not keyboard/modified clicks.
    const suppressPointerClick = (waitForRelease = false) => {
      cleanupClick.current?.();
      let timer = 0;
      const release = () => {
        doc.removeEventListener('click', handleClick, true);
        doc.removeEventListener('pointerup', handleRelease, true);
        doc.removeEventListener('pointercancel', handlePointerCancel, true);
        view.removeEventListener('blur', release);
        view.clearTimeout(timer);
        if (cleanupClick.current === release) cleanupClick.current = null;
      };
      const handleClick = (click: MouseEvent) => {
        if (click.detail === 0 || click.button !== 0 || click.altKey || click.ctrlKey || click.metaKey || click.shiftKey) return;
        if (Math.hypot(click.clientX - point.x, click.clientY - point.y) > 8) return;
        click.preventDefault();
        click.stopImmediatePropagation();
        release();
      };
      const handleRelease = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        point = { x: up.clientX, y: up.clientY };
        doc.removeEventListener('pointerup', handleRelease, true);
        doc.removeEventListener('pointercancel', handlePointerCancel, true);
        timer = view.setTimeout(release, 500);
      };
      const handlePointerCancel = (cancelled: PointerEvent) => { if (cancelled.pointerId === pointerId) release(); };
      if (waitForRelease) {
        // Escape can happen while the pointer remains held down. Wait for its
        // actual release, even if it later moves back over the source link.
        doc.addEventListener('pointerup', handleRelease, true);
        doc.addEventListener('pointercancel', handlePointerCancel, true);
      } else {
        timer = view.setTimeout(release, 500);
      }
      doc.addEventListener('click', handleClick, true);
      view.addEventListener('blur', release);
      cleanupClick.current = release;
    };

    const updateTarget = () => {
      const previousDragging = session.dragging;
      const next = session.update(point, hitTarget());
      if (!next.dragging) return;
      if (!previousDragging) {
        setDragState(source);
        try { element.setPointerCapture(pointerId); captured = true; } catch { /* Pointer may have left the document. */ }
      }
      const nextKey = next.dropTarget ? `${next.dropTarget.sessionId}:${next.dropTarget.position}` : '';
      if (nextKey !== lastDropKey) {
        lastDropKey = nextKey;
        setDropTarget(next.dropTarget);
      }
    };

    const scroll = () => {
      if (stopped || !session.dragging) return;
      if (scrollContainer) {
        const bounds = scrollContainer.getBoundingClientRect();
        if (point.x >= bounds.left && point.x <= bounds.right) {
          const delta = getGroupDragScrollDelta(point.y, bounds.top, bounds.bottom);
          const previousTop = scrollContainer.scrollTop;
          scrollContainer.scrollTop += delta;
          if (scrollContainer.scrollTop !== previousTop) updateTarget();
        }
      }
      frame = view.requestAnimationFrame(scroll);
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      view.cancelAnimationFrame(frame);
      doc.removeEventListener('pointermove', handleMove, true);
      doc.removeEventListener('pointerup', handleUp, true);
      doc.removeEventListener('pointercancel', handleCancel, true);
      doc.removeEventListener('keydown', handleKey, true);
      view.removeEventListener('blur', handleBlur);
      if (captured) {
        try { element.releasePointerCapture(pointerId); } catch { /* Capture can already have been released. */ }
      }
      if (cleanupDrag.current === cancel) cleanupDrag.current = null;
      if (mounted.current) {
        setDragState(null);
        setDropTarget(null);
      }
    };

    const cancel = (waitForRelease = true) => {
      if (session.dragging && mounted.current && waitForRelease) suppressPointerClick(true);
      session.cancel();
      stop();
    };
    const handleMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      point = { x: move.clientX, y: move.clientY };
      const wasDragging = session.dragging;
      updateTarget();
      if (session.dragging) {
        move.preventDefault();
        if (!wasDragging) frame = view.requestAnimationFrame(scroll);
      }
    };
    const handleUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      point = { x: up.clientX, y: up.clientY };
      if (session.dragging) {
        updateTarget();
        up.preventDefault();
        suppressPointerClick();
      }
      const move = session.finish();
      stop();
      if (!move) return;
      moving.current = true;
      setIsMoving(true);
      void Promise.resolve().then(() => latestOptions.current.onMove(
        move.groupId, move.sessionId, move.targetSessionId, move.position,
      )).catch((error: unknown) => {
        if (mounted.current) latestOptions.current.onError?.(error);
      }).finally(() => {
        moving.current = false;
        if (mounted.current) setIsMoving(false);
      });
    };
    const handleCancel = (cancelled: PointerEvent) => { if (cancelled.pointerId === pointerId) cancel(false); };
    const handleKey = (key: KeyboardEvent) => {
      if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); cancel(); }
    };
    const handleBlur = () => cancel(false);

    cleanupDrag.current = cancel;
    doc.addEventListener('pointermove', handleMove, { capture: true, passive: false });
    doc.addEventListener('pointerup', handleUp, true);
    doc.addEventListener('pointercancel', handleCancel, true);
    doc.addEventListener('keydown', handleKey, true);
    view.addEventListener('blur', handleBlur);
  }, [cancelDrag]);

  const rowProps = useCallback((groupId: string, sessionId: string): HTMLAttributes<HTMLDivElement> => ({
    onPointerDown: (event) => startDrag(event, { groupId, sessionId }, false),
    onDragStart: (event) => event.preventDefault(),
  }), [startDrag]);

  const dragHandleProps = useCallback((groupId: string, sessionId: string): ButtonHTMLAttributes<HTMLButtonElement> => ({
    type: 'button',
    style: { touchAction: 'none', userSelect: 'none' },
    onPointerDown: (event) => startDrag(event, { groupId, sessionId }, true),
    onClick: (event) => { event.preventDefault(); event.stopPropagation(); },
    onDragStart: (event) => event.preventDefault(),
  }), [startDrag]);

  return { dragState, dropTarget, isMoving, rowProps, dragHandleProps, cancelDrag };
}
