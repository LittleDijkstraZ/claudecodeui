import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { i18n as appI18n } from '@/modules/i18n';
import type { ConversationFileChange, DiffCalculator } from '@/shared/types';
import { calculateDiff } from '@/modules/chat/utils/messageTransforms';
import ConversationChangeContent from '@/modules/chat/changes/ConversationChangeContent';
import ConversationChangesBar from '@/modules/chat/changes/ConversationChangesBar';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });

const change = (extra: Partial<ConversationFileChange> = {}): ConversationFileChange => ({
  id: 'change-1', filePath: '/project/example.ts', operation: 'edit', sourceMessageKey: 'message-1',
  timestamp: '2026-09-07T12:00:00Z', ...extra,
});

function renderContent(item: ConversationFileChange, createDiff: DiffCalculator = calculateDiff) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ConversationChangeContent change={item} createDiff={createDiff} />
    </I18nextProvider>,
  );
}

test('a write without previous content shows written content and never invents an empty old file', () => {
  let diffCalls = 0;
  const html = renderContent(change({ operation: 'write', newContent: 'existing file overwritten' }), () => {
    diffCalls += 1;
    return [];
  });
  assert.equal(diffCalls, 0);
  assert.match(html, /Written content/);
  assert.match(html, /earlier content was not recorded/);
  assert.match(html, /existing file overwritten/);
  assert.doesNotMatch(html, /New File|Recorded edit/);
});

test('a bounded edit uses the existing diff viewer with the actual recorded before and after', () => {
  const calls: string[][] = [];
  const html = renderContent(change({ oldContent: 'before', newContent: 'after' }), (before, after) => {
    calls.push([before, after]);
    return calculateDiff(before, after);
  });
  assert.deepEqual(calls, [['before', 'after']]);
  assert.match(html, /Recorded edit/);
  assert.match(html, /before/);
  assert.match(html, /after/);
});

test('large line counts bypass the quadratic calculator and expose paged before/after content', () => {
  const html = renderContent(change({ oldContent: 'a\n'.repeat(3_000), newContent: 'b\n'.repeat(3_000) }), () => {
    throw new Error('Large edit must not invoke the quadratic calculator');
  });
  assert.match(html, /Recorded before/);
  assert.match(html, /Recorded after/);
  assert.match(html, /Content is paginated/);
  assert.match(html, />Next</);
  assert.ok(html.length < 10_000, `Large edit rendered ${html.length} characters of markup`);
});

test('one enormous line is bounded by characters as well as line count', () => {
  const html = renderContent(change({ operation: 'write', newContent: `${'a'.repeat(1_000_000)}FINAL_MARKER` }));
  assert.ok(html.length < 20_000);
  assert.match(html, />Next</);
  assert.doesNotMatch(html, /FINAL_MARKER/);
  assert.match(html, /Use Next to review the remaining content/);
});

test('patch-only records display their patch without claiming a reconstructed full file', () => {
  const html = renderContent(change({ operation: 'patch', patch: '@@ -1 +1 @@\n-before\n+after' }), () => {
    throw new Error('Patch-only record has no complete old/new pair');
  });
  assert.match(html, /Recorded patch/);
  assert.match(html, /@@ -1 \+1 @@/);
  assert.match(html, /-before/);
  assert.match(html, /\+after/);
});

test('an empty current turn is not mislabeled with earlier file changes', () => {
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ConversationChangesBar
        turns={[
          { id: 'old', label: 'Earlier request', timestamp: new Date(), changes: [change()] },
          { id: 'new', label: 'Current request', timestamp: new Date(), changes: [] },
        ]}
        isProcessing
        hasEarlierMessages={false}
        isLoadingEarlierMessages={false}
        onLoadAllMessages={async () => []}
        onJumpToChange={() => {}}
      />
    </I18nextProvider>,
  );
  assert.match(html, /Review changes/);
  assert.doesNotMatch(html, /No recorded edits in this turn yet/);
  assert.match(html, /1 earlier edit/);
  assert.doesNotMatch(html, /1 file changed/);
});


test('a new turn without recorded or unloaded edits adds no empty composer bar', () => {
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ConversationChangesBar turns={[{ id: 'new', label: 'Current request', timestamp: new Date(), changes: [] }]}
        isProcessing hasEarlierMessages={false} isLoadingEarlierMessages={false}
        onLoadAllMessages={async () => []} onJumpToChange={() => {}} />
    </I18nextProvider>,
  );
  assert.equal(html, '');
});
