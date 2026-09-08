import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { buildTranscriptMarkdown } from '@/modules/chat/export/buildTranscriptMarkdown';

const content = 'This session is being continued from a previous conversation. Synthetic continuation context.';
const message: ChatMessage = {
  id: 'compact-fixture', type: 'assistant', timestamp: '2026-08-01T12:00:00Z', content, isCompactSummary: true,
};
const callbacks = { onEditMessage: vi.fn(), onForkFromMessage: vi.fn(), onRetryPendingMessage: vi.fn() };
function row(value = message, requestId?: number, isExporting = false) {
  return <UiPreferencesProvider><TranscriptRenderContext.Provider value={{ isExporting }}>
    <MessageComponent message={value} prevMessage={null} provider="claude" createDiff={() => []} {...callbacks}
      revealTarget={requestId === undefined ? undefined : { messageKey: `message-${value.type}-${value.id}`, requestId }} />
  </TranscriptRenderContext.Provider></UiPreferencesProvider>;
}

test('native compaction context is collapsed and cannot be edited, retried or mistaken for a user send', async () => {
  // Defend against older normalized rows that already have the flag but still
  // report the native transport's user role and anchor.
  const view = render(row({ ...message, type: 'user', transcriptAnchorId: 'compact-fixture', delivery: 'failed' }));
  const details = view.container.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(screen.queryByText(content)).toBeNull();
  expect(screen.queryByText('U')).toBeNull();
  expect(view.container.querySelector('button')).toBeNull();
  fireEvent.click(details.querySelector('summary')!);
  await waitFor(() => expect(screen.getByText(content)).toBeTruthy());
  fireEvent.click(details.querySelector('summary')!);
  await waitFor(() => expect(screen.queryByText(content)).toBeNull());
});

test('each exact transcript jump reopens a collapsed summary', async () => {
  const view = render(row());
  view.rerender(row(message, 1));
  expect(screen.getByText(content)).toBeTruthy();
  fireEvent.click(view.container.querySelector('summary')!);
  await waitFor(() => expect(screen.queryByText(content)).toBeNull());
  view.rerender(row(message, 2));
  expect(screen.getByText(content)).toBeTruthy();
});

test('a user quoting the same words remains a normal editable user message', () => {
  const view = render(row({ ...message, type: 'user', isCompactSummary: undefined, transcriptAnchorId: 'human-fixture' }));
  expect(screen.getByText(content)).toBeTruthy();
  expect(screen.getByText('U')).toBeTruthy();
  expect(view.container.querySelector('details')).toBeNull();
});

test('history-to-UI projection retains the native summary identity and flag', () => {
  const [projected] = normalizedToChatMessages([{
    id: 'compact-fixture', sessionId: 'session-fixture', provider: 'claude', role: 'assistant', kind: 'text',
    content, timestamp: String(message.timestamp), isCompactSummary: true,
  }]);
  expect(projected.id).toBe(message.id);
  expect(projected.isCompactSummary).toBe(true);
  expect(projected.content).toBe(content);
});

test('exports retain the full context with an explicit compaction label', () => {
  const view = render(row(message, undefined, true));
  expect(view.container.querySelector('details')?.open).toBe(true);
  expect(screen.getByText(content)).toBeTruthy();
  const markdown = buildTranscriptMarkdown({ messages: [message], sessionTitle: 'Synthetic fixture', provider: 'claude',
    exportedAt: new Date('2026-08-01T12:00:00Z'), createDiff: () => [] });
  expect(markdown).toContain('### Compaction summary');
  expect(markdown).toContain(content);
  expect(markdown).not.toContain('### You');
});
