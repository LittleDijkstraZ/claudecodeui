import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { i18n as appI18n } from '@/modules/i18n';
import { useModalVisibility } from '@/shared/hooks/useModalVisibility';
import type { ConversationChangeTurn, ConversationFileChange } from '@/shared/types';
import ConversationChangesBar from '@/modules/chat/changes/ConversationChangesBar';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });
afterEach(cleanup);

function turn(id: string): ConversationChangeTurn {
  return {
    id, label: `${id} edits`, timestamp: '2026-09-07',
    changes: [{ id: `edit-${id}`, filePath: `/project/${id}.ts`, operation: 'edit', oldContent: 'before', newContent: 'after', sourceMessageKey: `source-${id}`, timestamp: '2026-09-07' }],
  };
}
const latestTurns = [turn('latest')];
const fullTurns = [turn('earlier'), ...latestTurns];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function WorkspaceHarness({ load, onJump = () => {} }: {
  load: (covered: boolean) => Promise<ConversationChangeTurn[]>;
  onJump?: (change: ConversationFileChange, covered: boolean) => void;
}) {
  const covered = useModalVisibility();
  // Keep the transcript props unchanged while covered, as WorkspaceMain does when it pauses chat subscription.
  return <I18nextProvider i18n={i18n}>
    <output data-testid="workspace-covered">{String(covered)}</output>
    <ConversationChangesBar turns={latestTurns} isProcessing={false} hasEarlierMessages isLoadingEarlierMessages={false}
      onLoadAllMessages={() => load(covered)} onJumpToChange={change => onJump(change, covered)} />
  </I18nextProvider>;
}

function openReview() {
  fireEvent.click(within(screen.getByTestId('conversation-changes-bar')).getByRole('button'));
}

test('full history loads inside a covering dialog and shows earlier edits without a background chat update', async () => {
  const request = deferred<ConversationChangeTurn[]>();
  const load = vi.fn(() => request.promise);
  render(<WorkspaceHarness load={load} />);
  openReview();
  assert.equal(screen.getByTestId('workspace-covered').textContent, 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));
  const loadingButton = screen.getByRole('button', { name: 'Loading history…' }) as HTMLButtonElement;
  assert.equal(loadingButton.disabled, true);
  fireEvent.click(loadingButton);
  assert.equal(load.mock.calls.length, 1);
  assert.deepEqual(load.mock.calls[0], [true]);

  await act(async () => request.resolve(fullTurns));
  assert.equal((screen.getByRole('combobox', { name: 'Changes to review' }) as HTMLSelectElement).value, 'all');
  assert.ok(within(screen.getByRole('dialog')).getByRole('button', { name: '/project/earlier.ts 1 edit' }));
  assert.ok(within(screen.getByRole('dialog')).getByRole('button', { name: '/project/latest.ts 1 edit' }));
  assert.equal(screen.queryByRole('button', { name: 'Load full conversation history' }), null);
  assert.equal(screen.getByTestId('workspace-covered').textContent, 'true');
});

test('failed history loads leave the existing edits and a working retry', async () => {
  const load = vi.fn<(covered: boolean) => Promise<ConversationChangeTurn[]>>()
    .mockRejectedValueOnce(new Error('History unavailable'))
    .mockResolvedValueOnce(fullTurns);
  render(<WorkspaceHarness load={load} />);
  openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));
  assert.match((await screen.findByRole('alert')).textContent ?? '', /Could not load the full history/);
  assert.ok(within(screen.getByRole('dialog')).getByRole('button', { name: '/project/latest.ts 1 edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));
  await waitFor(() => assert.ok(within(screen.getByRole('dialog')).getByRole('button', { name: '/project/earlier.ts 1 edit' })));
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(load.mock.calls.length, 2);
});

test('closing and reopening ignores an earlier request while a newer load is pending', async () => {
  const oldRequest = deferred<ConversationChangeTurn[]>();
  const newRequest = deferred<ConversationChangeTurn[]>();
  const load = vi.fn<(covered: boolean) => Promise<ConversationChangeTurn[]>>()
    .mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  render(<WorkspaceHarness load={load} />);
  openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close changes' }));
  openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));

  await act(async () => oldRequest.resolve([turn('stale')]));
  assert.equal(screen.queryByText('/project/stale.ts'), null);
  assert.equal((screen.getByRole('button', { name: 'Loading history…' }) as HTMLButtonElement).disabled, true);
  await act(async () => newRequest.resolve(fullTurns));
  assert.ok(within(screen.getByRole('dialog')).getByRole('button', { name: '/project/earlier.ts 1 edit' }));
});

test('a complete history with no recorded edits keeps the review open and removes the loading action', async () => {
  render(<WorkspaceHarness load={async () => []} />);
  openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));
  assert.ok(await screen.findByText('No recorded file edits in this selection.'));
  assert.ok(screen.getByRole('dialog'));
  assert.equal(screen.queryByRole('button', { name: 'Load full conversation history' }), null);
});

test('jumping to a newly loaded edit uses the callback after the workspace becomes active again', async () => {
  const jump = vi.fn();
  render(<WorkspaceHarness load={async () => fullTurns} onJump={jump} />);
  openReview();
  fireEvent.click(screen.getByRole('button', { name: 'Load full conversation history' }));
  const button = await screen.findByRole('button', { name: 'Jump to edit 1 of /project/earlier.ts in the conversation' });
  fireEvent.click(button);
  await waitFor(() => assert.equal(jump.mock.calls.length, 1));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(jump.mock.calls[0][0].filePath, '/project/earlier.ts');
  assert.equal(jump.mock.calls[0][1], false);
});
