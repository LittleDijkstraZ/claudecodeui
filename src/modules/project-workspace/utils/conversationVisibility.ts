// An embedded remote keeps running while its iframe is hidden. Its own
// visibilityState may still be visible, so every same-origin frame host matters.
const visibilityContext = (): { documents: Document[]; containers: Element[] } | null => {
  const documents: Document[] = [];
  const containers: Element[] = [];
  try {
    // On a narrow workspace, a maximized panel hides the chat even though the
    // page and selected session are unchanged. Observe that layout boundary too.
    const chat = document.querySelector('[data-testid="workspace-main-chat"]');
    for (let element: Element | null = chat; element; element = element.parentElement) containers.push(element);
    let current: Window = window;
    const seen = new Set<Window>();
    while (!seen.has(current)) {
      seen.add(current);
      documents.push(current.document);
      const frame = current.frameElement;
      if (!frame) {
        // An inaccessible cross-origin parent cannot establish that this pane
        // is being read; retain unread state instead of clearing it blindly.
        if (current.parent !== current) return null;
        break;
      }
      for (let element: Element | null = frame; element; element = element.parentElement) containers.push(element);
      const parent = frame.ownerDocument.defaultView;
      if (!parent) return null;
      current = parent;
    }
    return { documents, containers };
  } catch {
    return null;
  }
};

/** Used by useProjectsState to acknowledge messages only in a visible conversation pane. */
export function isConversationDocumentVisible(): boolean {
  const context = visibilityContext();
  if (!context || context.documents.some(document => document.visibilityState !== 'visible')) return false;
  return context.containers.every(element => {
    if (element.hasAttribute('hidden') || element.classList.contains('hidden') || element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse';
  });
}

/** Used by useProjectsState to notice when a retained iframe or background browser tab becomes readable again. */
export function observeConversationVisibility(onChange: () => void): () => void {
  const context = visibilityContext();
  const documents = context?.documents ?? [document];
  const observer = new MutationObserver(onChange);
  for (const container of context?.containers ?? []) observer.observe(container, { attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden', 'inert'] });
  for (const document of documents) document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('pageshow', onChange);
  return () => {
    observer.disconnect();
    for (const document of documents) document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('pageshow', onChange);
  };
}
