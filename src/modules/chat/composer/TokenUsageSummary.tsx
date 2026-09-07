import { memo, useState } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import TokenUsageModal from '@/modules/chat/modals/TokenUsageModal';
import { isClaudeUsageSnapshot } from '@/modules/chat/utils/claudeUsageSnapshot';
import type { LLMProvider } from '@/shared/types';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  provider?: LLMProvider;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Rendered by chat's ChatComposer to show the session's context-window usage
 * and open the detailed token breakdown on click.
 */
function TokenUsageSummary({ usage, provider, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  // Keep the details open while newer snapshots update their contents.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ledger = isClaudeUsageSnapshot(usage) ? usage : null;
  const unverifiedClaude = provider === 'claude' && !ledger;
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;

  const contextTokens = ledger?.context.usedTokens;
  return (<>
    <button
      type="button"
      onClick={() => { if (ledger || unverifiedClaude) setDetailsOpen(true); else onClick?.(); }}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={ledger ? t('chat:usage.context') : unverifiedClaude ? t(usage ? 'chat:usage.legacyExplanation' : 'chat:usage.awaitingExplanation') : t('chat:misc.tokensUsed', { count: usedTokens })}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{ledger ? (contextTokens == null ? t('chat:usage.unknown') : `≈ ${formatTokenCount(contextTokens)}`) : unverifiedClaude ? t(usage ? 'chat:usage.legacy' : 'chat:usage.awaiting') : formatTokenCount(usedTokens)}</span>
      {!unverifiedClaude && <span className="hidden text-muted-foreground/70 sm:inline">
        {ledger ? t('chat:usage.contextShort') : t('chat:misc.tokensLabel', { count: usedTokens })}
      </span>}
    </button>
    {detailsOpen && (ledger || unverifiedClaude) && <TokenUsageModal usage={usage} onClose={() => setDetailsOpen(false)} />}
  </>);
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
