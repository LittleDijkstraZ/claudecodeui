import type { ComponentProps } from 'react';
import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import type { ChatMessage } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string; count?: number }) => (options?.defaultValue ?? key).replace('{{count}}', String(options?.count)) }) }));
vi.mock('@/modules/chat/transcript/MessageComponent', () => ({ default: ({ message, onDismissPendingMessage, onRetryPendingMessage }: {
  message: ChatMessage; onDismissPendingMessage?: (message: ChatMessage) => void; onRetryPendingMessage?: (message: ChatMessage) => void;
}) => <article data-testid={`message-${message.id}`}>
  {message.content}
  <span>{message.delivery}</span>
  {message.delivery === 'failed' && <button onClick={() => onRetryPendingMessage?.(message)}>Retry</button>}
  {message.clientMessageId && <button onClick={() => onDismissPendingMessage?.(message)}>Remove local copy</button>}
</article> }));
vi.mock('@/modules/chat/transcript/ChatExportMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ProviderSelectionEmptyState', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ToolGroupContainer', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/LoadAllMessagesOverlay', () => ({ default: () => null }));

const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, type: 'user', timestamp: '2026-09-08T00:00:00Z', content: `Body ${id}`, ...extra });

test('unlocated recovered inputs appear once in a separate labelled section with their manual actions intact', () => {
  const onRetryPendingMessage = vi.fn(), onDismissPendingMessage = vi.fn();
  const native = message('native');
  const delivered = message('delivered', { clientMessageId: 'delivered-send', delivery: 'delivered', isUnlocatedLocalCopy: true });
  const failed = message('failed', { clientMessageId: 'failed-send', delivery: 'failed', isUnlocatedLocalCopy: true });
  const props = {
    chatMessages: [native, delivered, failed], visibleMessages: [native, delivered, failed], visibleMessageCount: 100,
    scrollContainerRef: createRef<HTMLDivElement>(), textareaRef: createRef<HTMLTextAreaElement>(), provider: 'claude',
    onRetryPendingMessage, onDismissPendingMessage, selectedSession: { id: 'session' },
  } as unknown as ComponentProps<typeof ChatMessagesPane>;
  const view = render(<ChatMessagesPane {...props} />);
  const section = screen.getByTestId('retained-local-messages');
  expect(section.contains(screen.getByTestId('message-native'))).toBe(false);
  expect(within(section).getByText('Body delivered')).toBeTruthy();
  expect(within(section).getByText('delivered')).toBeTruthy();
  expect(screen.getAllByTestId('message-failed')).toHaveLength(1);
  expect(within(section).getByText('2 retained local message copies')).toBeTruthy();
  expect(within(section).getByText(/Their position is unknown/)).toBeTruthy();
  fireEvent.click(within(section).getByText('Retry'));
  expect(onRetryPendingMessage).toHaveBeenCalledExactlyOnceWith(failed);
  fireEvent.click(within(screen.getByTestId('message-delivered')).getByText('Remove local copy'));
  expect(onDismissPendingMessage).toHaveBeenCalledExactlyOnceWith(delivered);
  // Once native identity has matched, the store retires the local copy; the
  // already-mounted pane returns to the normal transcript without duplication.
  view.rerender(<ChatMessagesPane {...props} chatMessages={[native]} visibleMessages={[native]} />);
  expect(screen.queryByTestId('retained-local-messages')).toBeNull();
  expect(screen.getAllByTestId('message-native')).toHaveLength(1);
});
