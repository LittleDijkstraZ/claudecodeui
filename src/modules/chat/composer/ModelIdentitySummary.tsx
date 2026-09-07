import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

type Report = { reportedModel?: string | null; reportedSource?: 'response' | 'initialization' | 'unknown'; reportedAt?: string | null };

/** Used by the chat composer to show evidence from this remote's existing transcript. */
export default function ModelIdentitySummary({ provider, sessionId, selectedModel, revision }: {
  provider: LLMProvider;
  sessionId: string | null;
  selectedModel: string;
  revision: string;
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
    <div className="mx-auto flex w-full max-w-[54.25rem] flex-wrap gap-x-3 gap-y-1 px-4 py-1 text-[11px] text-muted-foreground" data-testid="model-identity-summary">
      <span className="min-w-0 break-all">{t('modelIdentity.selected', { defaultValue: 'Selected' })}: <code>{selectedModel}</code></span>
      <span className="min-w-0 break-all" title={current?.reportedAt || undefined}>{label}: <code>{reportedModel}</code></span>
    </div>
  );
}
