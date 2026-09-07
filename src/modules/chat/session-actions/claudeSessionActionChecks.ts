import type { RewindMode, RewindPreview } from '@/shared/types';

/** Match only a server-confirmed saved UUID, never a timestamp or an optimistic UI ID. */
export function savedClaudeMessageId(messageId: unknown, savedIds: readonly string[]): string | null {
  if (typeof messageId !== 'string') return null;
  return savedIds.find(id => messageId === id || messageId.startsWith(`${id}_`)) ?? null;
}

export function isCurrentRewindPreview(preview: RewindPreview | null, mode: RewindMode, now = Date.now()): boolean {
  if (!preview || !preview.canRewind || preview.mode !== mode || !preview.previewToken) return false;
  const expiry = new Date(preview.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > now;
}
