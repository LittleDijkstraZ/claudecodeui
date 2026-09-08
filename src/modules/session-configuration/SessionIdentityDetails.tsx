import { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';

import { claudeExecutionSettingsApi } from '@/shared/api';
import type { ClaudeSessionIdentity, LLMProvider, ShellExecutionBinding } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

/** Shared compact identity entry for the main chat title and each originally bound terminal. */
export function SessionIdentityDetails({ sessionId, provider, label, binding }: { sessionId: string | null; provider?: LLMProvider; label: string; binding?: ShellExecutionBinding | null }) {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<ClaudeSessionIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !sessionId || (provider && provider !== 'claude')) return;
    const controller = new AbortController();
    setIdentity(null); setError(null);
    void claudeExecutionSettingsApi.identity(sessionId, { signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || 'Session identity unavailable');
      if (!controller.signal.aborted && payload.data?.sessionId === sessionId) setIdentity(payload.data);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [open, sessionId, provider]);
  if (!sessionId || (provider && provider !== 'claude')) return null;
  const current = identity?.sessionId === sessionId ? identity : null;
  return <>
    <button type="button" aria-label="Session identity and names" title="Session identity and names" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(true)}><Info className="h-3.5 w-3.5" /></button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto p-6">
      <div className="flex items-center justify-between gap-3"><DialogTitle className="not-sr-only text-base font-semibold">Session identity and names</DialogTitle><button type="button" aria-label="Close" onClick={() => setOpen(false)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent"><X className="h-4 w-4" /></button></div>
      <p className="break-words text-sm text-muted-foreground">{window.__REMOTE_NAME__ || window.__REMOTE_ID__ || 'Current remote'} · {label}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!error && !current && <p className="text-sm text-muted-foreground">Loading remote identity…</p>}
      {current && <>
        <dl className="space-y-3 text-sm">
          {[['CloudCLI name (preserved in this UI)', current.cloudcliName], ['Claude automatic title', current.automaticTitle], ['Claude /rename title', current.renamedTitle], ['CloudCLI conversation ID', current.sessionId], ['Claude session ID · current Chat', current.providerSessionId], ...(binding ? [['Claude session ID · this terminal', binding.providerSessionId], ['Terminal execution ID', binding.executionId]] : []), ['Remote folder', current.projectPath]].map(([name, value]) => <div key={name!}><dt className="text-xs text-muted-foreground">{name}</dt><dd className="mt-1 break-all">{value || 'Not reported'}</dd></div>)}
        </dl>
        {binding && binding.providerSessionId !== current.providerSessionId && <p className="text-sm text-amber-600">This retained terminal belongs to a different Claude branch than the current Chat. Its original binding has been preserved.</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">Names can differ while the Claude session ID is the same. CloudCLI keeps its saved name when Claude updates an automatic title. Older saved names do not record whether they were imported or manually set.</p>
        {current.titleCoverage !== 'complete' && <p className="text-xs text-muted-foreground">{current.titleCoverage === 'recent' ? 'Only recent title records were read; missing older titles are not inferred.' : 'Native title records are unavailable.'}</p>}
      </>}
    </DialogContent></Dialog>
  </>;
}
