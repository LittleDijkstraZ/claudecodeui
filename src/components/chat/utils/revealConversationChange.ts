import type { MessageRevealTarget } from '../types/messageReveal';

/** Wait for folded tool records to open, then reveal the exact recorded edit. */
export function revealConversationChange(
  container: HTMLElement,
  target: MessageRevealTarget,
  onSettled: (found: boolean) => void,
): () => void {
  let frame = 0;
  let cancelled = false;
  const startedAt = performance.now();
  let stableFrames = 0;
  let lastGeometry = '';
  let highlighted: HTMLElement | null = null;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    if (cancelled) return;
    if (!container.isConnected) { onSettled(false); return; }
    const elapsed = performance.now() - startedAt;
    const parent = Array.from(container.querySelectorAll<HTMLElement>('[data-message-key]'))
      .find((element) => element.dataset.messageKey === target.messageKey);
    const child = target.toolId && parent
      ? Array.from(parent.querySelectorAll<HTMLElement>('[data-tool-id]'))
        .find((element) => element.dataset.toolId === target.toolId)
      : undefined;
    const element = target.toolId && parent?.dataset.toolId !== target.toolId ? child : parent;
    let hidden = false;
    // Subagent history stays mounted inside zero-height collapsed ancestors.
    for (let ancestor = element?.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
      if (ancestor.dataset.state === 'closed') hidden = true;
    }
    if (element && !hidden && element.getClientRects().length > 0) {
      const bounds = element.getBoundingClientRect();
      const containerBounds = container.getBoundingClientRect();
      const absoluteTop = bounds.top - containerBounds.top + container.scrollTop;
      const geometry = `${Math.round(absoluteTop)}:${Math.round(bounds.height)}:${container.scrollHeight}`;
      stableFrames = geometry === lastGeometry ? stableFrames + 1 : 0;
      lastGeometry = geometry;
      container.scrollTop = absoluteTop - Math.max(0, (container.clientHeight - Math.min(bounds.height, container.clientHeight)) / 2);

      // Allow the existing 200ms collapse transition to finish; don't declare
      // success just because the still-hidden DOM node exists on the first frame.
      if (elapsed >= 220 && stableFrames >= 3) {
        element.focus({ preventScroll: true });
        element.classList.add('search-highlight-flash');
        highlighted = element;
        highlightTimer = setTimeout(() => element.classList.remove('search-highlight-flash'), 4000);
        onSettled(true);
        return;
      }
    }
    if (elapsed >= 2000) {
      onSettled(false);
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    if (highlightTimer) clearTimeout(highlightTimer);
    highlighted?.classList.remove('search-highlight-flash');
  };
}
