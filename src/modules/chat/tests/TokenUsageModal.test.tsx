import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, test, vi } from 'vitest';

import TokenUsageModal from '@/modules/chat/modals/TokenUsageModal';
import { i18n as appI18n } from '@/modules/i18n';
import type { ClaudeUsageSnapshot } from '@/shared/types';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });
afterEach(cleanup);

test('token details expose a named dialog and explicit close control, with Escape still supported', () => {
  const close = vi.fn();
  render(<I18nextProvider i18n={i18n}><TokenUsageModal usage={null} onClose={close} /></I18nextProvider>);
  const heading = screen.getByRole('heading', { name: i18n.t('usage.title', { ns: 'chat' }) });
  expect(screen.getByRole('dialog', { name: heading.textContent ?? '' })).toBeTruthy();
  expect(heading.classList.contains('not-sr-only')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('misc.close', { ns: 'chat' }) }));
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(2);
});

test('a live token update keeps the dialog open and updates its current-context content', () => {
  const usage: ClaudeUsageSnapshot = {
    schemaVersion: 2, provider: 'claude', sessionId: 'fixture', nativeContextId: 'native-fixture', revision: 1, updatedAt: '2026-09-07',
    context: { usedTokens: 1234, model: 'reported-model', capacityTokens: null, compactionWindowTokens: null, measurement: 'last-request', observedAt: '2026-09-07' },
    turn: null,
    session: { models: {}, tokens: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, knownEstimatedCostUsd: 0, provisional: true, historicalCoverage: 'observed-requests', warnings: [] },
  };
  const close = vi.fn();
  const view = render(<I18nextProvider i18n={i18n}><TokenUsageModal usage={usage} onClose={close} /></I18nextProvider>);
  expect(screen.getByText('≈ 1,234')).toBeTruthy();
  view.rerender(<I18nextProvider i18n={i18n}><TokenUsageModal usage={{ ...usage, revision: 2, context: { ...usage.context, usedTokens: 2345 } }} onClose={close} /></I18nextProvider>);
  expect(screen.getByText('≈ 2,345')).toBeTruthy();
  expect(screen.queryByText('≈ 1,234')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});
