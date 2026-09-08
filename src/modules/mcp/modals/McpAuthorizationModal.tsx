import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { mcpAuthApi } from '@/shared/api';
import type { McpAuthAttempt, ProviderMcpServer } from '@/shared/types';
import { Button, Dialog, DialogContent, Input } from '@/shared/ui';

type Props = { server: ProviderMcpServer; onClose: () => void };
const done = (attempt: McpAuthAttempt | null) => attempt && ['connected', 'failed', 'expired', 'cancelled'].includes(attempt.status);

/** Used by MCP settings to authenticate its fixed remote and wait for native MCP connection evidence. */
export function McpAuthorizationModal({ server, onClose }: Props) {
  const { t } = useTranslation('settings');
  // Authorization material lives only in this modal's memory, never local storage or logs.
  const [attempt, setAttempt] = useState<McpAuthAttempt | null>(null);
  // Track initialization/callback requests separately from the remote authorization lifecycle.
  const [busy, setBusy] = useState(false);
  // Keep retryable network errors visible without throwing away the ongoing remote sign-in.
  const [error, setError] = useState<string | null>(null);
  // A refused browser redirect can be pasted directly back to the same remote CLI.
  const [callbackUrl, setCallbackUrl] = useState('');
  // Do not offer the browser link until loopback reservation has either succeeded or explicitly fallen back.
  const [relay, setRelay] = useState<'idle' | 'preparing' | 'ready' | 'manual'>('idle');
  const attemptRef = useRef<McpAuthAttempt | null>(null);
  const generation = useRef(0);
  const update = (value: McpAuthAttempt) => { attemptRef.current = value; setAttempt(value); };
  const start = async () => {
    if (busy) return;
    const version = ++generation.current;
    setBusy(true); setError(null); setCallbackUrl(''); setRelay('idle');
    try {
      if (attemptRef.current) await mcpAuthApi.cancel(attemptRef.current.id);
      const next = await mcpAuthApi.start(server);
      if (version === generation.current) update(next);
      else void mcpAuthApi.cancel(next.id).catch(() => {});
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : 'Authorization unavailable'); }
    finally { if (version === generation.current) setBusy(false); }
  };
  useEffect(() => {
    // Defer the launch so StrictMode's setup/cleanup probe cannot start two remote OAuth processes.
    const timer = window.setTimeout(() => { void start(); }, 0);
    return () => { window.clearTimeout(timer); ++generation.current; const current = attemptRef.current; if (current) void mcpAuthApi.cancel(current.id).catch(() => {}); };
  // The parent keys this modal by server identity; reopening deliberately starts a fresh attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!attempt || done(attempt)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void mcpAuthApi.read(attempt.id).then(next => { if (active) { update(next); setError(null); } }).catch(cause => {
        if (active) { setError(cause instanceof Error ? cause.message : 'Remote disconnected'); setAttempt(current => current ? { ...current } : null); }
      });
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [attempt]);
  useEffect(() => {
    if (attempt?.status !== 'awaiting-browser' || relay !== 'idle') return;
    let active = true; const version = generation.current; setRelay('preparing');
    void mcpAuthApi.prepareLocalCallback(attempt.id).then(() => {
      if (active) setRelay('ready');
      else if (generation.current !== version) void mcpAuthApi.cancel(attempt.id).catch(() => {});
    }).catch(() => { if (active) setRelay('manual'); });
    return () => { active = false; };
  // Changing relay itself must not cancel the in-flight reservation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.id, attempt?.status]);
  const submit = async () => {
    if (!attempt || busy) return;
    setBusy(true); setError(null);
    try { update(await mcpAuthApi.callback(attempt.id, callbackUrl.trim())); setCallbackUrl(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Callback failed'); }
    finally { setBusy(false); }
  };
  const status = attempt?.status;
  const machine = window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('mcpAuth.currentRemote', { defaultValue: 'Current remote' });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[88dvh] w-[calc(100%-1rem)] max-w-xl overflow-y-auto p-5" aria-label={t('mcpAuth.title', { defaultValue: 'Connect remote MCP' })}>
    <div className="mb-4 flex items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-base font-semibold">{server.name} · {machine}</h2><Button variant="ghost" size="icon" aria-label={t('mcpAuth.close', { defaultValue: 'Close' })} onClick={onClose}><X className="h-4 w-4" /></Button></div>
    <p className="text-sm text-muted-foreground">{t('mcpAuth.explanation', { defaultValue: 'Sign in using this browser. Credentials stay with Claude on the selected remote; this dialog waits for that MCP server to connect.' })}</p>
    <div role="status" className={`my-4 rounded border p-3 text-sm ${status === 'connected' ? 'border-emerald-500/40 text-emerald-600' : 'border-border'}`}>
      {(!attempt || ['starting','verifying'].includes(status || '')) && <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />}
      {status === 'connected' ? t('mcpAuth.connected', { defaultValue: 'Connected — confirmed by the remote MCP health check.' }) : status === 'awaiting-browser' ? t('mcpAuth.waiting', { defaultValue: 'Waiting for browser authorization.' }) : status === 'verifying' ? t('mcpAuth.verifying', { defaultValue: 'Checking the remote MCP connection…' }) : done(attempt) ? t('mcpAuth.incomplete', { defaultValue: 'Authorization has not completed.' }) : t('mcpAuth.starting', { defaultValue: 'Starting sign-in on the remote…' })}
    </div>
    {attempt?.authorizationUrl && status === 'awaiting-browser' && <>
      {relay === 'preparing' ? <p className="text-sm">{t('mcpAuth.preparing', { defaultValue: 'Preparing the local callback…' })}</p> : <a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded bg-primary px-3 py-2 text-sm text-primary-foreground"><ExternalLink className="h-4 w-4" />{t('mcpAuth.openBrowser', { defaultValue: 'Open authorization page' })}</a>}
      <p className="mt-3 text-xs text-muted-foreground">{relay === 'ready' ? t('mcpAuth.automatic', { defaultValue: 'The local callback is ready and bound to this remote. If the browser redirect still fails, paste its complete address below.' }) : t('mcpAuth.manual', { defaultValue: 'After signing in, a localhost connection error is possible. Copy the entire address from that page and paste it below; it will be delivered to this remote.' })}</p>
      <label className="mt-4 block text-sm">{t('mcpAuth.callback', { defaultValue: 'Full callback URL' })}<Input autoComplete="off" spellCheck={false} value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} className="mt-1" placeholder="http://localhost:…/callback?…" /></label>
      <Button disabled={!callbackUrl.trim() || busy} onClick={() => void submit()} className="mt-2">{t('mcpAuth.sendCallback', { defaultValue: 'Send to this remote' })}</Button>
    </>}
    {(error || attempt?.error) && <p role="alert" className="mt-3 text-sm text-destructive">{error || attempt?.error}</p>}
    {(done(attempt) || error && !attempt) && status !== 'connected' && <Button variant="outline" disabled={busy} onClick={() => void start()} className="mt-4"><RefreshCw className="mr-2 h-4 w-4" />{t('mcpAuth.retry', { defaultValue: 'Start a new authorization' })}</Button>}
    <p className="mt-4 text-xs text-muted-foreground">{t('mcpAuth.limit', { defaultValue: 'No chat is created or sent. Existing running chats may need their MCP connection refreshed before the newly authorized tools appear.' })}</p>
  </DialogContent></Dialog>;
}
