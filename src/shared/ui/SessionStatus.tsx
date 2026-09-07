import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/shared/ui/Tooltip';
import { cn } from '@/shared/utils';

/** Used by sidebar and remote-hub rows to share the same running indicator and explanation. */
export function SessionRunningIndicator({ isProcessing }: { isProcessing: boolean }) {
  const { t } = useTranslation('sidebar');
  if (!isProcessing) return null;
  const label = t('tooltips.processingSessionIndicator', 'Processing session');
  return <Tooltip content={label} position="top"><span role="status" aria-label={label} data-session-status="running" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /></span></Tooltip>;
}

/** Used by sidebar and remote-hub rows for unread attention and recently active sessions. */
export function SessionAttentionIndicator({ needsAttention, isRecent = false, className }: { needsAttention: boolean; isRecent?: boolean; className?: string }) {
  const { t } = useTranslation('sidebar');
  if (!needsAttention && !isRecent) return null;
  const label = needsAttention ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' }) : t('tooltips.activeSessionIndicator');
  return <span className={cn('inline-flex shrink-0', className)}><Tooltip content={label} position="right"><span role="status" aria-label={label} data-session-status={needsAttention ? 'attention' : 'recent'} className={cn('block h-2 w-2 animate-pulse rounded-full', needsAttention ? 'bg-amber-500' : 'bg-green-500')} /></Tooltip></span>;
}
