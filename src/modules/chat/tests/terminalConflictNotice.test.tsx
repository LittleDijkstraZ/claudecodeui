import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { TerminalConflictNotice } from '@/modules/chat/composer/TerminalConflictNotice';
import type { NormalizedMessage } from '@/shared/types';

const { revealTerminal } = vi.hoisted(() => ({ revealTerminal: vi.fn() }));
vi.mock('@/modules/workspace-panels', () => ({ useWorkspacePanelActions: () => ({ revealTerminal }) }));
const conflict: NormalizedMessage = {
  id: 'refusal', sessionId: 'current-session', provider: 'claude', kind: 'status', text: 'execution_conflict',
  timestamp: '2026-09-08T11:00:00Z', executionId: 'owning-execution', providerSessionId: 'native-session',
};
const delivered: NormalizedMessage = {
  id: 'client_retained', sessionId: 'current-session', provider: 'claude', kind: 'text', role: 'user',
  timestamp: '2026-09-07T00:00:00Z', clientMessageId: 'old-send', delivery: 'delivered', content: 'Old input',
};
beforeEach(() => revealTerminal.mockReset());

test('an unmatched restored delivered copy cannot hide a current terminal refusal or its handoff action', () => {
  render(<TerminalConflictNotice records={[conflict, { ...delivered, isUnlocatedLocalCopy: true }]} sessionId="current-session" />);
  expect(screen.getByRole('status').textContent).toContain('Chat 未接受这条消息');
  fireEvent.click(screen.getByRole('button', { name: '查看现有终端' }));
  expect(revealTerminal).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'current-session', executionId: 'owning-execution', providerSessionId: 'native-session',
  });
});

test.each(['native', 'delivered'] as const)('a later %s user input still clears a superseded terminal refusal', kind => {
  const later = { ...delivered, timestamp: '2026-09-08T11:00:01Z', delivery: kind === 'native' ? undefined : delivered.delivery };
  render(<TerminalConflictNotice records={[conflict, later]} sessionId="current-session" />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(revealTerminal).not.toHaveBeenCalled();
});
