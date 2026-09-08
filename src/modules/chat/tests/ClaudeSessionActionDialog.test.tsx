import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { i18n as appI18n } from '@/modules/i18n';
import ClaudeSessionActionDialog from '@/modules/chat/modals/ClaudeSessionActionDialog';
import type { ClaudeSessionMutationEvent, RewindResult } from '@/shared/types';

const requests = vi.hoisted(() => ({ preview: vi.fn(), rewind: vi.fn(), fork: vi.fn() }));
vi.mock('@/shared/api', () => ({ previewClaudeRewind: requests.preview, rewindClaudeSession: requests.rewind, forkClaudeSession: requests.fork }));
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });
const result: RewindResult = {
  sessionId: 'stable-app', provider: 'claude', projectId: 'project', projectPath: '/fixture/project', sessionName: 'Fixture',
  mode: 'conversation', contextChanged: true, contextRevision: 'new-context', backupSessionId: 'original-branch',
  previousProviderSessionId: 'native-old', providerSessionId: 'native-new',
};
beforeEach(() => {
  requests.preview.mockReset().mockImplementation(async (_session: string, messageId: string, mode: string) => ({
    previewToken: 'preview-token', expiresAt: Date.now() + 60_000, messageId, mode, canRewind: true,
    filesChanged: [], insertions: 0, deletions: 0, conversationBoundary: 'includes-selected-message',
  }));
  requests.rewind.mockReset().mockResolvedValue(result); requests.fork.mockReset();
});
function openDialog(onRewound = vi.fn(async (_value: RewindResult) => {}), onClose = vi.fn()) {
  render(<MemoryRouter><I18nextProvider i18n={i18n}><ClaudeSessionActionDialog type="rewind" sessionId="stable-app"
    messageId="saved-target" message="The exact saved target prompt" onClose={onClose} onRewound={onRewound} /></I18nextProvider></MemoryRouter>);
  return { onRewound, onClose };
}

test('rewind identifies the saved target and explains background and pending-input impact before confirmation', async () => {
  openDialog();
  expect(screen.getByText('The exact saved target prompt')).toBeTruthy();
  expect(screen.getByText('saved-target')).toBeTruthy();
  expect(screen.getByText(/does not interrupt tasks automatically/)).toBeTruthy();
  expect(screen.getByText(/not sent automatically to the restored context/)).toBeTruthy();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Restore this point' }) as HTMLButtonElement).disabled).toBe(false));
  expect(requests.rewind).not.toHaveBeenCalled();
});

test('commit quarantines old-context input before history refresh and exposes the retained original branch', async () => {
  const phases: ClaudeSessionMutationEvent[] = [];
  const listener = (event: Event) => phases.push((event as CustomEvent<ClaudeSessionMutationEvent>).detail);
  window.addEventListener('cloudcli:session-mutation', listener);
  let finish!: () => void;
  const refreshGate = new Promise<void>(resolve => { finish = resolve; });
  const onRewound = vi.fn(async () => {
    expect(phases.map(item => item.phase)).toEqual(['started', 'committed']);
    await refreshGate;
  });
  try {
    const view = openDialog(onRewound);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore this point' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Restore this point' }));
    await waitFor(() => expect(onRewound).toHaveBeenCalledWith(result));
    expect(phases[0].requestId).toBe(phases[1].requestId);
    expect(phases[1].result).toEqual(result);
    await act(async () => { finish(); await refreshGate; });
    expect(screen.getByRole('link', { name: 'Open the original conversation branch' }).getAttribute('href')).toBe('/session/original-branch');
    expect(screen.queryByRole('button', { name: 'Restore this point' })).toBeNull();
    expect(view.onClose).not.toHaveBeenCalled();
  } finally { window.removeEventListener('cloudcli:session-mutation', listener); }
});

test('a failed post-commit history refresh is never reported as a failed mutation or retried', async () => {
  const phases: string[] = [];
  const listener = (event: Event) => phases.push((event as CustomEvent<ClaudeSessionMutationEvent>).detail.phase);
  window.addEventListener('cloudcli:session-mutation', listener);
  try {
    openDialog(vi.fn(async () => { throw new Error('Fixture history read failed'); }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore this point' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Restore this point' }));
    await screen.findByRole('alert');
    expect(phases).toEqual(['started', 'committed']);
    expect(requests.rewind).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Open the original conversation branch' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore this point' })).toBeNull();
  } finally { window.removeEventListener('cloudcli:session-mutation', listener); }
});

test('an unconfirmed HTTP outcome sends a failed lifecycle without fabricating a committed branch', async () => {
  requests.rewind.mockRejectedValue(new Error('Connection lost before response'));
  const phases: ClaudeSessionMutationEvent[] = [];
  const listener = (event: Event) => phases.push((event as CustomEvent<ClaudeSessionMutationEvent>).detail);
  window.addEventListener('cloudcli:session-mutation', listener);
  try {
    const view = openDialog();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore this point' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Restore this point' }));
    await screen.findByRole('alert');
    expect(phases.map(item => item.phase)).toEqual(['started', 'failed']);
    expect(phases[1].result).toBeUndefined();
    expect(view.onRewound).not.toHaveBeenCalled();
  } finally { window.removeEventListener('cloudcli:session-mutation', listener); }
});
