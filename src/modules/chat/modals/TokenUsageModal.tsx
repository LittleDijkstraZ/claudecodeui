import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { isClaudeUsageSnapshot } from '@/modules/chat/utils/claudeUsageSnapshot';
import type { ClaudeUsageBuckets, ClaudeUsageModelCounters, ClaudeUsageSnapshot } from '@/shared/types';

const tokens = (value: number | null): string => value === null ? '—' : value.toLocaleString();
const sum = (value: ClaudeUsageBuckets): number => value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens;
const money = (value: number): string => `$${value.toFixed(value < 0.01 && value > 0 ? 5 : 4)}`;

/** Used by the composer and /cost details to separate current context from consumed tokens and estimated cost. */
export function ClaudeUsageDetails({ usage }: { usage: ClaudeUsageSnapshot }) {
  const { t } = useTranslation('chat');
  const rows = (models: Record<string, ClaudeUsageModelCounters>) => Object.entries(models).map(([model, value]) => (
    <tr key={model} className="border-t border-border/50">
      <th scope="row" className="max-w-56 break-all py-2 pr-3 text-left font-normal" title={model.startsWith('<') ? t('usage.unknownModel') : model}>{model.startsWith('<') ? t('usage.unknownModel') : model}</th>
      <td className="px-2 py-2 text-right tabular-nums">{tokens(value.inputTokens)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{tokens(value.cacheReadTokens)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{tokens(value.cacheWriteTokens)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{tokens(value.outputTokens)}</td>
      <td className="py-2 pl-2 text-right tabular-nums">{value.estimatedCostUsd === null ? t('usage.unknown') : money(value.estimatedCostUsd)}</td>
    </tr>
  ));
  const table = (models: Record<string, ClaudeUsageModelCounters>) => <div className="overflow-x-auto"><table className="w-full text-xs">
    <thead><tr className="text-muted-foreground">{['model', 'input', 'cacheRead', 'cacheWrite', 'output', 'estimatedCost'].map(key => <th key={key} className="whitespace-nowrap px-2 py-2 text-right first:pl-0 first:text-left">{t(`usage.${key}`)}</th>)}</tr></thead>
    <tbody>{rows(models)}</tbody>
  </table></div>;
  const current = usage.context;
  const turnTokens = usage.turn ? Object.values(usage.turn.models).reduce((total, value) => total + sum(value), 0) : null;
  return <div className="space-y-5">
    <section aria-label={t('usage.context')} className="rounded-xl border border-border p-4">
      <h3 className="font-semibold">{t('usage.context')}</h3>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{current.usedTokens === null ? t('usage.unknown') : `≈ ${tokens(current.usedTokens)}`}</div>
      <p className="mt-1 text-xs text-muted-foreground">{current.measurement === 'sdk-local-estimate' ? t('usage.localEstimate') : current.measurement === 'unavailable' ? t('usage.noContext') : current.measurement === 'post-compact' ? t('usage.postCompact') : t('usage.lastSampling')}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">{t('usage.actualModel')}</dt><dd className="break-all font-mono text-xs">{current.model ?? t('usage.unknown')}</dd></div>
        <div><dt className="text-muted-foreground">{t('usage.capacity')}</dt><dd>{current.capacityTokens === null ? t('usage.unknown') : tokens(current.capacityTokens)}</dd></div>
        {current.compactionWindowTokens !== null && <div><dt className="text-muted-foreground">{t('usage.compactionWindow')}</dt><dd>{tokens(current.compactionWindowTokens)}</dd></div>}
      </dl>
    </section>
    <section aria-label={t('usage.turn')} className="rounded-xl border border-border p-4">
      <h3 className="font-semibold">{t('usage.turn')} <span className="text-sm font-normal text-muted-foreground">{usage.turn ? t(`usage.${usage.turn.status}`) : t('usage.unknown')}</span></h3>
      <p className="mt-2 text-xl tabular-nums">{turnTokens === null ? '—' : tokens(turnTokens)} <span className="text-sm text-muted-foreground">{t('usage.tokens')}</span></p>
      {usage.turn && table(usage.turn.models)}
      {usage.turn?.coverage === 'observed-requests' && <p className="mt-2 text-xs text-muted-foreground">{t('usage.partialTurn')}</p>}
    </section>
    <section aria-label={t('usage.session')} className="rounded-xl border border-border p-4">
      <h3 className="font-semibold">{t('usage.session')}</h3>
      <p className="mt-2 text-xl tabular-nums">{tokens(sum(usage.session.tokens))} <span className="text-sm text-muted-foreground">{t('usage.tokens')}{usage.session.provisional ? ` · ${t('usage.running')}` : ''}</span></p>
      <p className="mt-1 text-sm">{t('usage.estimatedCost')}: {usage.session.estimatedCostUsd === null
        ? (usage.session.knownEstimatedCostUsd > 0 ? t('usage.knownCost', { cost: money(usage.session.knownEstimatedCostUsd) }) : t('usage.unknown'))
        : money(usage.session.estimatedCostUsd)}</p>
      {table(usage.session.models)}
      {usage.session.historicalCoverage === 'observed-requests' && <p className="mt-2 text-xs text-muted-foreground">{t('usage.historicalPartial')}</p>}
      {usage.session.historicalCoverage === 'inherited-context' && <p className="mt-2 text-xs text-muted-foreground">{t('usage.inherited')}</p>}
      {usage.session.warnings.some(warning => !warning.startsWith('historical-')) && <p className="mt-2 text-xs text-muted-foreground">{t('usage.accountingPartial')}</p>}
    </section>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('usage.explanation')}</p>
  </div>;
}

/** Used by the composer and /cost when an older server has not supplied distinct accounting quantities. */
export function UnverifiedClaudeUsageDetails({ usage }: { usage: Record<string, unknown> | null }) {
  const { t } = useTranslation('chat');
  // A legacy counter can switch between per-request and per-run usage. Preserve
  // it only as a labelled raw observation, never as context, capacity or a bill.
  const reported = typeof usage?.used === 'number' && Number.isFinite(usage.used) && usage.used >= 0 ? usage.used : null;
  return <div className="space-y-4">
    <section className="rounded-xl border border-border p-4">
      <h3 className="font-semibold">{t(usage ? 'usage.legacy' : 'usage.awaiting')}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(usage ? 'usage.legacyExplanation' : 'usage.awaitingExplanation')}</p>
      {reported !== null && <dl className="mt-3 text-sm"><dt className="text-muted-foreground">{t('usage.unverifiedValue')}</dt><dd className="tabular-nums">{tokens(reported)}</dd></dl>}
    </section>
    {usage && <p className="text-xs leading-relaxed text-muted-foreground">{t('usage.legacyRefresh')}</p>}
  </div>;
}

/** The composer opens this live view; receiving a newer snapshot updates an already-open dialog. */
export default function TokenUsageModal({ usage, onClose }: { usage: Record<string, unknown> | null; onClose: () => void }) {
  const { t } = useTranslation('chat');
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
    <DialogTitle>{t('usage.title')}</DialogTitle>
    {isClaudeUsageSnapshot(usage) ? <ClaudeUsageDetails usage={usage} /> : <UnverifiedClaudeUsageDetails usage={usage} />}
  </DialogContent></Dialog>;
}
