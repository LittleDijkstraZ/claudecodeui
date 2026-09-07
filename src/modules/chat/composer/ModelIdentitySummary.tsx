import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SessionExecutionSettings } from '@/modules/session-configuration';
import { api } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

type Report = { reportedModel?: string | null; reportedSource?: 'response' | 'initialization' | 'unknown'; reportedAt?: string | null };

/** Used inside the model menu to show evidence from this remote's existing transcript on demand. */
export default function ModelIdentitySummary({ provider, sessionId, selectedModel, revision, continuesExecution = false }: {
  provider: LLMProvider;
  sessionId: string | null;
  selectedModel: string;
  revision: string;
  continuesExecution?: boolean;
}) {
  const { t } = useTranslation('chat');
  // The reported model is independent of the pending user selection and scoped to its session.
  const [report, setReport] = useState<(Report & { sessionId: string }) | null>(null);
  useEffect(() => {
    if (provider !== 'claude' || !sessionId) return;
    const controller = new AbortController();
    // Coalesce streaming rerenders; no query/model inference is launched by this endpoint.
    const timer = setTimeout(() => {
      void api.providers.sessionActiveModel('claude', sessionId, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('Model report unavailable');
          const payload = await response.json();
          if (!controller.signal.aborted) setReport({ sessionId, ...(payload.success ? payload.data : {}) });
        })
        .catch(() => { if (!controller.signal.aborted) setReport({ sessionId, reportedSource: 'unknown' }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [provider, sessionId, revision]);
  if (provider !== 'claude') return null;
  const current = report?.sessionId === sessionId ? report : null;
  const label = current?.reportedSource === 'response'
    ? t('modelIdentity.lastResponse', { defaultValue: 'Last response' })
    : current?.reportedSource === 'initialization'
      ? t('modelIdentity.runtimeResolved', { defaultValue: 'Runtime resolved (no response yet)' })
      : t('modelIdentity.actual', { defaultValue: 'Actual model' });
  const reportedModel = current?.reportedModel || t('modelIdentity.unconfirmed', { defaultValue: 'Unconfirmed' });
  return (
    <>
    <div className="space-y-1 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground" data-testid="model-identity-summary">
      {continuesExecution && <p>{t('modelIdentity.continuesExecution', { defaultValue: 'Messages use the running process’s applied settings. Changes apply when the next execution starts.' })}</p>}
      <span className="block min-w-0 break-all">{t('modelIdentity.selected', { defaultValue: 'Selected' })}: <code>{selectedModel}</code></span>
      <span className="block min-w-0 break-all" title={current?.reportedAt || undefined}>{label}: <code>{reportedModel}</code></span>
    </div>
    <SessionExecutionSettings provider={provider} sessionId={sessionId} surface="chat" presentation="menu" />
    </>
  );
}
