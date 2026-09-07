import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2, GitFork, Loader2, RotateCcw, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui';

import {
  forkClaudeSession,
  previewClaudeRewind,
  rewindClaudeSession,
  type RewindMode,
  type RewindPreview,
  type RewindResult,
} from './claudeSessionActionsApi';
import { isCurrentRewindPreview } from './claudeSessionActionChecks';

type ClaudeSessionActionDialogProps = {
  type: 'sideChat' | 'rewind';
  sessionId: string;
  messageId: string;
  message: string;
  onClose: () => void;
  onRewound: (result: RewindResult) => Promise<void>;
};

export default function ClaudeSessionActionDialog({ type, sessionId, messageId, message, onClose, onRewound }: ClaudeSessionActionDialogProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const modeName = useId();
  const isRewind = type === 'rewind';
  const [mode, setMode] = useState<RewindMode>('conversation');
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(isRewind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [now, setNow] = useState(Date.now());
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
    try {
      if (isRewind) {
        const result = await rewindClaudeSession(sessionId, messageId, mode, preview!.previewToken);
        if (mounted.current) setCompleted(true);
        // Refresh from actual saved history only after the server changes context.
        await onRewound(result);
        window.dispatchEvent(new CustomEvent('cloudcli:session-rewound', { detail: result }));
      } else {
        const result = await forkClaudeSession(sessionId, messageId);
        window.dispatchEvent(new CustomEvent('cloudcli:side-chat-open', { detail: result }));
      }
      if (mounted.current) onClose();
    } catch (reason) {
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
        <blockquote className="mb-4 max-h-28 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">{message.trim().slice(0, 500) || t('sessionActions.attachmentMessage')}{message.length > 500 ? '…' : ''}</blockquote>
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
        {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{completed ? t('sessionActions.refreshFailed') + ' ' : ''}{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t(completed ? 'sessionActions.close' : 'sessionActions.cancel')}</Button>
          <Button type="button" variant={isRewind ? 'destructive' : 'default'} disabled={busy || completed || (isRewind && (previewLoading || !validPreview))} onClick={() => { void confirm(); }}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t(isRewind ? 'sessionActions.confirmRewind' : 'sessionActions.confirmSideChat')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
