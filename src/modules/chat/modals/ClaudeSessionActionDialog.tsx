import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2, GitFork, Loader2, RotateCcw, X } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import {
  forkClaudeSession,
  previewClaudeRewind,
  rewindClaudeSession,
} from '@/shared/api';
import type { ClaudeSessionMutationEvent, RewindMode, RewindPreview, RewindResult } from '@/shared/types';
import { isCurrentRewindPreview } from '@/modules/chat/session-actions/claudeSessionActionChecks';

type ClaudeSessionActionDialogProps = {
  type: 'sideChat' | 'rewind';
  sessionId: string;
  messageId: string;
  message: string;
  onClose: () => void;
  onRewound: (result: RewindResult) => Promise<void>;
};

/** Used by chat session actions to preview and confirm a native Claude fork or rewind. */
export default function ClaudeSessionActionDialog({ type, sessionId, messageId, message, onClose, onRewound }: ClaudeSessionActionDialogProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const modeName = useId();
  const isRewind = type === 'rewind';
  // Keep the requested rewind scope until the user changes it.
  const [mode, setMode] = useState<RewindMode>('conversation');
  // Retain the exact server preview token and affected files for confirmation.
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  // Allow a fresh preview after expiry or a changed source transcript.
  const [previewRevision, setPreviewRevision] = useState(0);
  // Disable confirmation while the selected rewind scope is being previewed.
  const [previewLoading, setPreviewLoading] = useState(isRewind);
  // Prevent duplicate fork or rewind requests while a mutation is in flight.
  const [busy, setBusy] = useState(false);
  // Show a server failure without discarding the reviewable preview.
  const [error, setError] = useState<string | null>(null);
  // Prevent a second rewind if the server committed but refreshing the UI failed.
  const [completed, setCompleted] = useState(false);
  // Preserve the original branch link even if refreshing the new context fails.
  const [committedResult, setCommittedResult] = useState<RewindResult | null>(null);
  // Expire a preview promptly even when the user leaves the dialog open.
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!isRewind) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    void previewClaudeRewind(sessionId, messageId, mode, controller.signal).then(result => {
      if (!controller.signal.aborted) { setPreview(result); setNow(Date.now()); }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [isRewind, sessionId, messageId, mode, previewRevision]);

  useEffect(() => {
    if (!preview) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [preview]);

  const confirm = async () => {
    if (busy || completed || (isRewind && !isCurrentRewindPreview(preview, mode))) return;
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    let committed = false;
    const mutation = (phase: ClaudeSessionMutationEvent['phase'], extra: Pick<ClaudeSessionMutationEvent, 'result' | 'error'> = {}) => {
      window.dispatchEvent(new CustomEvent<ClaudeSessionMutationEvent>('cloudcli:session-mutation', {
        detail: { sessionId, messageId, mode, requestId, phase, ...extra },
      }));
    };
    try {
      if (isRewind) {
        mutation('started');
        const result = await rewindClaudeSession(sessionId, messageId, mode, preview!.previewToken);
        committed = true;
        if (mounted.current) { setCompleted(true); setCommittedResult(result); }
        // Pending input must be quarantined at commit, before resetHistory or
        // any awaited refresh can make this stable app ID look ready to send.
        mutation('committed', { result });
        window.dispatchEvent(new CustomEvent('cloudcli:session-rewound', { detail: result }));
        // Refresh from actual saved history only after the server changes context.
        await onRewound(result);
      } else {
        const result = await forkClaudeSession(sessionId, messageId);
        window.dispatchEvent(new CustomEvent('cloudcli:side-chat-open', { detail: result }));
      }
      if (mounted.current && !isRewind) onClose();
    } catch (reason) {
      if (isRewind && !committed) mutation('failed', { error: reason instanceof Error ? reason.message : String(reason) });
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const validPreview = isCurrentRewindPreview(preview, mode, now);
  const expired = preview?.canRewind && !validPreview;
  const fileMode = mode !== 'conversation';

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent aria-labelledby={titleId} className="max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-2xl overflow-y-auto p-4 sm:p-6" data-testid="claude-session-action-dialog">
        <div className="mb-4 flex items-center gap-2">
          {isRewind ? <RotateCcw className="h-5 w-5 shrink-0" /> : <GitFork className="h-5 w-5 shrink-0" />}
          <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{t(`sessionActions.${type}`)}</DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="ml-auto h-8 w-8" aria-label={t('sessionActions.close')} disabled={busy} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <p className="mb-1 text-xs font-medium">{t('sessionActions.target')}</p>
        <blockquote className="mb-2 max-h-28 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">{message.trim().slice(0, 500) || t('sessionActions.attachmentMessage')}{message.length > 500 ? '…' : ''}</blockquote>
        <details className="mb-4 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('sessionActions.targetIdentity')}</summary><code className="mt-1 block break-all">{messageId}</code></details>
        {isRewind ? (
          <div className="space-y-4">
            <fieldset disabled={busy || completed} className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{t('sessionActions.rewindMode')}</legend>
              {(['conversation', 'files', 'both'] as RewindMode[]).map(value => (
                <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === value ? 'border-primary bg-primary/5' : 'border-border'}`}>
                  <input type="radio" name={modeName} value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-0.5 accent-primary" />
                  <span><span className="block text-sm font-medium">{t(`sessionActions.modes.${value}`)}</span><span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t(`sessionActions.modeDescriptions.${value}`)}</span></span>
                </label>
              ))}
            </fieldset>
            {mode !== 'files' && <p className="text-xs leading-relaxed text-muted-foreground">{t('sessionActions.contextBoundary')} {t('sessionActions.backup')} {t('sessionActions.checkpointAfterRewind')}</p>}
            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>{t('sessionActions.backgroundImpact')}</p>
              <p>{t(mode === 'files' ? 'sessionActions.pendingFilesImpact' : 'sessionActions.pendingContextImpact')}</p>
            </div>
            {fileMode && <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200">{t('sessionActions.fileScope')}</p>}
            <section className="overflow-hidden rounded-xl border border-border" aria-live="polite">
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-sm font-medium"><FileCode2 className="h-4 w-4" />{t('sessionActions.preview')}</div>
              <div className="p-3">
                {previewLoading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('sessionActions.previewLoading')}</p> : preview ? (
                  <>
                    {!preview.canRewind && <p className="text-sm text-destructive">{preview.error || t('sessionActions.unavailable')}</p>}
                    {preview.canRewind && (fileMode ? <>
                      <p className="text-sm">{t('sessionActions.fileCount', { count: preview.filesChanged.length })}</p>
                      {preview.filesChanged.length > 0 ? <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg bg-muted/20 p-2 text-xs">{preview.filesChanged.map(path => <li key={path} className="flex items-start gap-2 break-all py-1"><FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span>{path}</span></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">{t('sessionActions.noFiles')}</p>}
                      {(preview.insertions > 0 || preview.deletions > 0) && <p className="mt-2 text-xs"><span className="text-green-700 dark:text-green-300">+{preview.insertions}</span>{' / '}<span className="text-red-700 dark:text-red-300">−{preview.deletions}</span></p>}
                    </> : <p className="text-sm text-muted-foreground">{t('sessionActions.filesUnchanged')}</p>)}
                    {expired && <p className="mt-2 text-sm text-destructive">{t('sessionActions.expired')}</p>}
                  </>
                ) : null}
                {!previewLoading && <Button type="button" variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" disabled={busy || completed} onClick={() => setPreviewRevision(value => value + 1)}>{t('sessionActions.refreshPreview')}</Button>}
              </div>
            </section>
          </div>
        ) : (
          <div className="space-y-3 text-sm leading-relaxed">
            <p>{t('sessionActions.sideChatDescription')}</p>
            <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">{t('sessionActions.sharedFiles')}</p>
          </div>
        )}
        {completed && <div role="status" className="mt-4 space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
          <p>{t('sessionActions.restored')}</p>
          {committedResult?.backupSessionId && <Link className="inline-block underline underline-offset-2" to={`/session/${committedResult.backupSessionId}`} onClick={onClose}>{t('sessionActions.openBackup')}</Link>}
        </div>}
        {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{completed ? t('sessionActions.refreshFailed') + ' ' : ''}{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t(completed ? 'sessionActions.close' : 'sessionActions.cancel')}</Button>
          {!completed && <Button type="button" variant={isRewind ? 'destructive' : 'default'} disabled={busy || (isRewind && (previewLoading || !validPreview))} onClick={() => { void confirm(); }}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t(isRewind ? 'sessionActions.confirmRewind' : 'sessionActions.confirmSideChat')}
          </Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
