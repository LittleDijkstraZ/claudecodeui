import { useTranslation } from 'react-i18next';
import { PencilIcon, XIcon } from 'lucide-react';

type QueuedMessageCardProps = {
  content: string;
  /** A rewind backup can be inspected or edited, but never dispatched automatically. */
  rewindPaused?: boolean;
  attachmentCount?: number;
  attachmentNames?: string[];
  /** A busy remote lacking live input must not present this draft as delivered. */
  waitingForRemoteRun?: boolean;
  onEdit: () => void;
  onDelete: () => void;
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
  onEdit,
  onDelete,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span>{rewindPaused ? t('input.queue.paused', { defaultValue: 'Paused saved message' }) : t('input.queue.label', { defaultValue: 'Queued' })}</span>
            <span className="normal-case text-muted-foreground/60">
              · {rewindPaused ? t('input.queue.pausedHint', { defaultValue: 'Will not send automatically' }) : waitingForRemoteRun ? t('input.queue.notDelivered') : t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
            </span>
          </div>
          {waitingForRemoteRun && <p className="mt-1 text-xs text-muted-foreground">{t('input.queue.remoteUnsupported')}</p>}
          {rewindPaused && attachmentNames.length > 0 && <p className="mt-1 break-words text-xs text-muted-foreground">{t('input.queue.retainedFiles', { names: attachmentNames.join(', '), defaultValue: 'Retained files: {{names}}. Select them again if you copy this text into a new send.' })}</p>}
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{content}</p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={rewindPaused ? t('input.queue.copyPaused', { defaultValue: 'Copy paused text to composer' }) : t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            title={rewindPaused ? t('input.queue.copyPausedHint', { defaultValue: 'Copy text to composer; retained files stay here for review' }) : t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
