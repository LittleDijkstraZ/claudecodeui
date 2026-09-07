import assert from 'node:assert/strict';

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, test } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { i18n as appI18n } from '@/modules/i18n';
import type { ConversationChangeTurn, ConversationFileChange } from '@/shared/types';
import ConversationChangesBar from '@/modules/chat/changes/ConversationChangesBar';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });
afterEach(cleanup);

const change = (extra: Partial<ConversationFileChange> = {}): ConversationFileChange => ({
  id: 'change-1', filePath: '/project/file.ts', operation: 'edit', oldContent: 'before', newContent: 'after\nextra',
  sourceMessageKey: 'source-1', timestamp: '2026-09-07', ...extra,
});
function renderBar(turns: ConversationChangeTurn[]) {
  return render(<I18nextProvider i18n={i18n}><ConversationChangesBar turns={turns} isProcessing={false}
    hasEarlierMessages={false} isLoadingEarlierMessages={false} onLoadAllMessages={() => {}} onJumpToChange={() => {}} /></I18nextProvider>);
}

test('the compact trigger displays colored totals for the latest turn, then follows the selected review scope', () => {
  renderBar([
    { id: 'previous', label: 'Earlier edits', timestamp: '2026-09-06', changes: [change({ id: 'old', oldContent: '', newContent: 'new' })] },
    { id: 'latest', label: 'Latest edits', timestamp: '2026-09-07', changes: [change()] },
  ]);
  const bar = screen.getByTestId('conversation-changes-bar');
  const totals = within(bar).getByTestId('conversation-change-totals');
  assert.equal(totals.textContent, '+2−1');
  assert.ok(within(totals).getByText('+2').className.includes('text-green-700'));
  assert.ok(within(totals).getByText('−1').className.includes('text-red-700'));
  assert.match(totals.getAttribute('aria-label') ?? '', /Latest turn.*not a Git net diff/);
  fireEvent.click(within(bar).getByRole('button'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Changes to review' }), { target: { value: 'all' } });
  assert.equal(within(bar).getByTestId('conversation-change-totals').textContent, '+3−1');
  assert.match(within(bar).getByRole('button').textContent ?? '', /All loaded conversation/);
  fireEvent.change(screen.getByRole('combobox', { name: 'Changes to review' }), { target: { value: 'turn:previous' } });
  assert.equal(within(bar).getByTestId('conversation-change-totals').textContent, '+1−0');
  fireEvent.click(screen.getByRole('button', { name: 'Close changes' }));
  assert.match(within(bar).getByRole('button').textContent ?? '', /Earlier edits/);
});

test('unknown writes display unknown totals rather than treating written lines as new additions', () => {
  renderBar([{ id: 'latest', label: 'Write', timestamp: '2026-09-07', changes: [change({ operation: 'write', oldContent: undefined })] }]);
  const totals = screen.getByTestId('conversation-change-totals');
  assert.equal(totals.textContent, '+?−?unknown');
  assert.match(totals.getAttribute('aria-label') ?? '', /Line totals are unavailable/);
  assert.doesNotMatch(totals.textContent ?? '', /\+2/);
});

test('partly recorded edits distinguish known totals from the unavailable remainder', () => {
  renderBar([{ id: 'latest', label: 'Mixed', timestamp: '2026-09-07', changes: [change(), change({ id: 'unknown', oldContent: undefined })] }]);
  const totals = screen.getByTestId('conversation-change-totals');
  assert.equal(totals.textContent, '+2−1partial');
  assert.match(totals.getAttribute('aria-label') ?? '', /only the countable edits/);
});

test('an empty latest turn does not inherit earlier turn line counts', () => {
  renderBar([
    { id: 'previous', label: 'Edited earlier', timestamp: '2026-09-06', changes: [change()] },
    { id: 'latest', label: 'Explanation only', timestamp: '2026-09-07', changes: [] },
  ]);
  assert.equal(screen.queryByTestId('conversation-change-totals'), null);
  assert.match(screen.getByTestId('conversation-changes-bar').textContent ?? '', /1 earlier edit/);
});
