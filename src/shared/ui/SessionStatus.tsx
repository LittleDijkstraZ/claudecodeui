import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/shared/ui/Tooltip';
import { cn } from '@/shared/utils';

/** Used by sidebar and remote-hub rows to share the same running indicator and explanation. */
export function SessionRunningIndicator({ isProcessing }: { isProcessing: boolean }) {
  const { t } = useTranslation('sidebar');
  if (!isProcessing) return null;
  const label = t('tooltips.processingSessionIndicator', 'Processing session');
  return <Tooltip content={label} position="top"><span role="status" aria-label={label} data-session-status="running" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-amber-500"><Loader2 className="h-3 w-3 animate-spin" /></span></Tooltip>;
}

/** Used by sidebar and remote-hub rows only for unread messages, independently of running state. */
export function SessionAttentionIndicator({ needsAttention, className }: { needsAttention: boolean; className?: string }) {
  const { t } = useTranslation('sidebar');
  if (!needsAttention) return null;
  const label = t('tooltips.unreadMessagesIndicator', { defaultValue: 'Unread messages' });
  return <span className={cn('inline-flex shrink-0', className)}><Tooltip content={label} position="right"><span role="status" aria-label={label} data-session-status="attention" className="block h-2 w-2 rounded-full bg-green-500" /></Tooltip></span>;
}
