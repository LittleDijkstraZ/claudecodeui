import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { ChatMessage, ScrollRestoreState, NormalizedMessage, Project, ProjectSession, SessionRuntimeState, SubagentInfo } from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session, accounting for Cursor sessions that
 * carry a `name` instead of the summary the other providers return.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

//----------------- REMOTE STORAGE ------------

/** Namespaces all embedded-machine browser data, including auth and drafts. */
export const remoteStorageKey = (remoteId: string, key: string) => `cloudcli:remote:${remoteId}:${key}`;

// ---------------------------

//----------------- RECORDED SUBAGENT STATE ------------

/** Uses the provider lifecycle when reported, with tool-result fallback for older normalized agent records. */
export function getSubagentStatus(message: ChatMessage): SubagentInfo['status'] {
  return message.subagent?.status ?? (message.toolResult ? (message.toolResult.isError ? 'failed' : 'completed') : 'running');
}

// ---------------------------

//----------------- SESSION INPUT CAPABILITY ------------

/** Reads only validated runtime fields from websocket/poll snapshots; missing fields never grant live input capability. */
export function readSessionRuntimeState(value: Record<string, unknown>): SessionRuntimeState {
  return {
    ...(typeof value.foregroundTurnId === 'string' && value.foregroundTurnId ? { foregroundTurnId: value.foregroundTurnId } : {}),
    ...(typeof value.foregroundStartedAt === 'string' && Number.isFinite(Date.parse(value.foregroundStartedAt)) ? { foregroundStartedAt: value.foregroundStartedAt } : {}),
    ...(value.phase === 'foreground' || value.phase === 'background' ? { phase: value.phase } : {}),
    ...(typeof value.acceptsInput === 'boolean' ? { acceptsInput: value.acceptsInput } : {}),
    ...(typeof value.canInterruptQueuedMessages === 'boolean' ? { canInterruptQueuedMessages: value.canInterruptQueuedMessages } : {}),
    ...(typeof value.canStopTask === 'boolean' ? { canStopTask: value.canStopTask } : {}),
    ...(Array.isArray(value.inputModes) ? { inputModes: [...new Set(value.inputModes.filter((mode): mode is 'queue' | 'interrupt' => mode === 'queue' || mode === 'interrupt'))] } : {}),
    ...(typeof value.backgroundTasks === 'number' && Number.isSafeInteger(value.backgroundTasks) && value.backgroundTasks >= 0 ? { backgroundTasks: value.backgroundTasks } : {}),
    ...(typeof value.executionId === 'string' && value.executionId ? { executionId: value.executionId } : {}),
  };
}

//----------------- USER MESSAGE IDENTITY ------------

/** Chat reconciliation and its local outbox compare native/client identities only, never prompt text.
 * A native anchor is accepted only from a provider row or explicit remote receipt. Different
 * sessions/providers cannot share identity; normalized block IDs may differ within one native row.
 */
export function hasSameUserMessageIdentity(left: NormalizedMessage, right: NormalizedMessage): boolean {
  if (left.kind !== 'text' || right.kind !== 'text' || left.role !== 'user' || right.role !== 'user'
    || left.sessionId !== right.sessionId || left.provider !== right.provider) return false;
  if (left.clientMessageId && right.clientMessageId && left.clientMessageId !== right.clientMessageId) return false;
  if (left.transcriptAnchorId && right.transcriptAnchorId && left.transcriptAnchorId !== right.transcriptAnchorId) return false;
  const responseIds = [left.responseMessageId, ...(left.responseMessageIds || [])].filter(Boolean);
  if ([right.responseMessageId, ...(right.responseMessageIds || [])].some(id => Boolean(id) && responseIds.includes(id))) return true;
  const leftIds = [left.clientMessageId, left.transcriptAnchorId, left.id].filter(Boolean);
  return [right.clientMessageId, right.transcriptAnchorId, right.id].some(id => Boolean(id) && leftIds.includes(id));
}

// ---------------------------

//----------------- SCROLL POSITION RESTORATION ------------

/** Captures stable row wrappers, including placeholders whose message content is unmounted. */
export function captureScrollRestoreState(container: HTMLElement): ScrollRestoreState {
  const bounds = container.getBoundingClientRect();
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row]'))
    .find(element => {
      const row = element.getBoundingClientRect();
      return row.bottom > bounds.top && row.top < bounds.bottom;
    }) ?? null;
  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : null,
  };
}

/** Corrects only the remaining displacement, so browser scroll anchoring is never applied twice. */
export function restoreScrollPosition(container: HTMLElement, snapshot: ScrollRestoreState): void {
  const { anchor, anchorOffset, height, top } = snapshot;
  if (anchor && container.contains(anchor) && anchorOffset !== null) {
    const delta = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorOffset;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
  } else {
    container.scrollTop = top + container.scrollHeight - height;
  }
}

// ---------------------------

//----------------- CONVERSATION VISIBILITY ------------

// An embedded remote keeps running while its iframe is hidden. Its own
// visibilityState may still be visible, so every same-origin frame host matters.
const conversationVisibilityContext = (): { documents: Document[]; containers: Element[] } | null => {
  const documents: Document[] = [];
  const containers: Element[] = [];
  try {
    // A maximized or narrow panel can cover chat without changing its session.
    const chat = document.querySelector('[data-testid="workspace-main-chat"]');
    for (let element: Element | null = chat; element; element = element.parentElement) containers.push(element);
    let current: Window = window;
    const seen = new Set<Window>();
    while (!seen.has(current)) {
      seen.add(current);
      documents.push(current.document);
      const frame = current.frameElement;
      if (!frame) {
        // An inaccessible parent cannot establish that the conversation is visible.
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

/** Lets workspaces defer hidden history reads and acknowledge messages only in visible conversations. */
export function isConversationDocumentVisible(): boolean {
  const context = conversationVisibilityContext();
  if (!context || context.documents.some(document => document.visibilityState !== 'visible')) return false;
  return context.containers.every(element => {
    if (element.hasAttribute('hidden') || element.classList.contains('hidden') || element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse';
  });
}

/** Notifies workspace reading state when a retained frame, parent panel, or browser tab changes visibility. */
export function observeConversationVisibility(onChange: () => void): () => void {
  const context = conversationVisibilityContext();
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

// ---------------------------
