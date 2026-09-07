import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { expect, test } from 'vitest';

import { acceptClaudeUsageSnapshot } from '@/modules/chat/utils/claudeUsageSnapshot';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import { ClaudeUsageDetails } from '@/modules/chat/modals/TokenUsageModal';
import { i18n as appI18n } from '@/modules/i18n';
import type { ClaudeUsageSnapshot } from '@/shared/types';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });
const snapshot = (revision = 1, sessionId = 'app-one'): ClaudeUsageSnapshot => ({
  schemaVersion: 2, provider: 'claude', sessionId, nativeContextId: 'native-one', revision, updatedAt: '2026-09-09T00:00:00Z',
  context: { usedTokens: 80_100, model: 'actual-explicit', capacityTokens: 1_000_000, compactionWindowTokens: 200_000, measurement: 'last-request', observedAt: '2026-09-09T00:00:00Z' },
  turn: null,
  session: { models: {}, tokens: { inputTokens: 0, cacheReadTokens: 8_000_000, cacheWriteTokens: 0, outputTokens: 100 }, estimatedCostUsd: null, knownEstimatedCostUsd: .25, provisional: false, historicalCoverage: 'observed-requests', warnings: [] },
});

test('REST, websocket and history share a monotonic revision and enforce session/remote identities', () => {
  const live = snapshot(9);
  expect(acceptClaudeUsageSnapshot(live, snapshot(8), 'app-one', 'coral')).toBe(live);
  expect(acceptClaudeUsageSnapshot(live, snapshot(9), 'app-one', 'coral')).toBe(live);
  expect(acceptClaudeUsageSnapshot(live, snapshot(10, 'another'), 'app-one', 'coral')).toBe(live);
  expect(acceptClaudeUsageSnapshot(live, snapshot(10), 'app-one', 'coral', 'temp')).toBe(live);
  expect(acceptClaudeUsageSnapshot(live, { used: 8_000_000 }, 'app-one', 'coral')).toBe(live);
  expect(acceptClaudeUsageSnapshot(live, null, 'app-one', 'coral')).toBe(live);
  const rewind = { ...snapshot(10), nativeContextId: 'rewound', context: { ...live.context, usedTokens: 1234 } };
  expect(acceptClaudeUsageSnapshot(live, rewind, 'app-one', 'coral')).toBe(rewind);
  expect(acceptClaudeUsageSnapshot(rewind, live, 'app-one', 'coral')).toBe(rewind);
});

test('composer shows the 80K context rather than an 8M bill, and details distinguish all three quantities', () => {
  const value = snapshot();
  const button = renderToStaticMarkup(<I18nextProvider i18n={i18n}><TokenUsageSummary usage={value} /></I18nextProvider>);
  expect(button).toContain('≈ 80K');
  expect(button).not.toContain('8M');
  expect(button).toContain('context');
  const details = renderToStaticMarkup(<I18nextProvider i18n={i18n}><ClaudeUsageDetails usage={value} /></I18nextProvider>);
  expect(details).toContain('80,100'); expect(details).toContain('8,000,100');
  expect(details).toContain('1,000,000'); expect(details).toContain('200,000');
  expect(details).toContain('Current context'); expect(details).toContain('Current / latest turn consumed');
  expect(details).toContain('Whole conversation consumed'); expect(details).toContain('remaining cost unknown');
});

test('unknown context and unknown capacity remain explicit without a guessed 160K fallback', () => {
  const value = snapshot(); value.context = { ...value.context, usedTokens: null, capacityTokens: null, compactionWindowTokens: null, measurement: 'unavailable' };
  const button = renderToStaticMarkup(<I18nextProvider i18n={i18n}><TokenUsageSummary usage={value} /></I18nextProvider>);
  expect(button).toContain('Unknown'); expect(button).not.toContain('8M');
  const details = renderToStaticMarkup(<I18nextProvider i18n={i18n}><ClaudeUsageDetails usage={value} /></I18nextProvider>);
  expect(details).not.toContain('160,000'); expect(details).toContain('No reliable context observation yet');
});
