import { useTranslation } from 'react-i18next';
import { Loader2, PencilIcon, XIcon, ZapIcon } from 'lucide-react';

type QueuedMessageCardProps = {
  content: string;
  /** A rewind backup can be inspected or edited, but never dispatched automatically. */
  rewindPaused?: boolean;
  attachmentCount?: number;
  attachmentNames?: string[];
  /** A busy remote lacking live input must not present this draft as delivered. */
  waitingForRemoteRun?: boolean;
  additionalMessages?: string[];
  onInterrupt?: () => void;
  interruptDisabled?: boolean;
  interrupting?: boolean;
  interruptError?: string | null;
  onEdit?: () => void;
  onDelete?: () => void;
};

/**
 * Rendered by chat's ChatComposer to show the message queued for a busy
 * session, with edit and delete actions before it is auto-sent.
 */
export default function QueuedMessageCard({
  content,
  rewindPaused = false,
  attachmentCount = 0,
  attachmentNames = [],
  waitingForRemoteRun = false,
  additionalMessages = [],
  onInterrupt,
  interruptDisabled = false,
  interrupting = false,
  interruptError,
  onEdit,
  onDelete,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div data-testid="queued-message-card" className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-blue-500/20 bg-blue-500/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
            <span>{rewindPaused ? t('input.queue.paused', { defaultValue: 'Paused saved message' }) : t('input.queue.label', { defaultValue: 'Queued' })}</span>
            <span className="normal-case text-muted-foreground/60">
              · {rewindPaused ? t('input.queue.pausedHint', { defaultValue: 'Will not send automatically' }) : waitingForRemoteRun ? t('input.queue.notDelivered') : t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
            </span>
          </div>
          {waitingForRemoteRun && <p className="mt-1 text-xs text-muted-foreground">{t('input.queue.remoteUnsupported')}</p>}
          {rewindPaused && attachmentNames.length > 0 && <p className="mt-1 break-words text-xs text-muted-foreground">{t('input.queue.retainedFiles', { names: attachmentNames.join(', '), defaultValue: 'Retained files: {{names}}. Select them again if you copy this text into a new send.' })}</p>}
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{content}</p>
          {additionalMessages.map((text, index) => <p key={index} className="mt-2 line-clamp-2 break-words border-t border-blue-500/10 pt-2 text-sm text-foreground/90">{text}</p>)}
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {onEdit && <button
            type="button"
            onClick={onEdit}
            aria-label={rewindPaused ? t('input.queue.copyPaused', { defaultValue: 'Copy paused text to composer' }) : t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            title={rewindPaused ? t('input.queue.copyPausedHint', { defaultValue: 'Copy text to composer; retained files stay here for review' }) : t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>}
          {onDelete && <button
            type="button"
            onClick={onDelete}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>}
        </div>
      </div>
      {!rewindPaused && onInterrupt && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-blue-500/10 pt-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{interruptDisabled
          ? t('input.queue.interruptUnavailable', { defaultValue: 'This execution has not confirmed support for interrupting queued messages.' })
          : t('input.queue.interruptHint', { defaultValue: 'Handle queued messages now; background tasks keep running.' })}</p>
        <button type="button" onClick={onInterrupt} disabled={interruptDisabled || interrupting}
          aria-label={t('input.queue.interrupt', { defaultValue: 'Interrupt to process queued messages' })}
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-blue-500/25 bg-background/70 px-2.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-300">
          {interrupting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ZapIcon className="h-3.5 w-3.5" />}
          {interrupting ? t('input.queue.interrupting', { defaultValue: 'Interrupting…' }) : t('input.interrupt', { defaultValue: 'Interrupt' })}
        </button>
      </div>}
      {interruptError && <p role="alert" className="mt-2 text-xs text-destructive">{interruptError}</p>}
    </div>
  );
}
