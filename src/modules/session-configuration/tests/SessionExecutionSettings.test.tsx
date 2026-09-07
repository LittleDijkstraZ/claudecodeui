import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionExecutionSettings } from '@/modules/session-configuration';
import { api, claudeExecutionSettingsApi } from '@/shared/api';
import type { ClaudeSessionExecutionSnapshot } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: { providers: { models: vi.fn(async () => ({ json: async () => ({ data: { models: { OPTIONS: [
    { value: 'fixture-exact', label: 'Fixture', effort: { values: [{ value: 'high' }, { value: 'xhigh' }, { value: 'ultracode' }] } },
  ] } } }) })) } },
  claudeExecutionSettingsApi: { read: vi.fn(), update: vi.fn() },
}));

const snapshot: ClaudeSessionExecutionSnapshot = {
  sessionId: 'app-fixture', providerSessionId: 'native-fixture', projectPath: '/remote/project',
  next: { model: 'fixture-exact', effort: 'xhigh', ultracode: true, revision: 'revision-1' },
  execution: { executionId: 'run-fixture', appSessionId: 'app-fixture', providerSessionId: 'native-fixture',
    surface: 'shell', requested: { model: 'fixture-exact', effort: 'xhigh', ultracode: true, revision: 'revision-1' },
    status: 'running', startedAt: '2026-01-01', endedAt: null, observed: {} },
};
const response = (data: ClaudeSessionExecutionSnapshot) => ({ ok: true, json: async () => ({ success: true, data }) }) as Response;

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

describe('shared execution configuration', () => {
  beforeEach(() => {
    vi.mocked(api.providers.models).mockClear();
    vi.mocked(claudeExecutionSettingsApi.read).mockReset().mockResolvedValue(response(snapshot));
    vi.mocked(claudeExecutionSettingsApi.update).mockReset();
  });
  it('does not claim requested model, xhigh or Ultracode as actual execution evidence', async () => {
    render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="shell" executionId="run-fixture" />);
    await waitFor(() => expect(screen.getByText(/启动时请求/)).toBeTruthy());
    expect(screen.getByText(/^实际报告：/).textContent).toContain('模型 未确认；effort 未确认；Ultracode 未确认');
    expect(claudeExecutionSettingsApi.read).toHaveBeenCalledWith('app-fixture', 'run-fixture', expect.any(Object));
  });
  it('keeps evidence inside the model menu without duplicating next-setting controls', async () => {
    render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="chat" presentation="menu" />);
    await waitFor(() => expect(screen.getByText(/^下次启动：/)).toBeTruthy());
    expect(screen.getByText('本次执行与下次启动设置')).toBeTruthy();
    expect(screen.getByText(/向当前运行中的对话追加消息不会应用新设置/)).toBeTruthy();
    expect(screen.queryByLabelText('Next execution model')).toBeNull();
    expect(screen.queryByLabelText('Next execution effort')).toBeNull();
    fireEvent.click(screen.getByText('本次执行与下次启动设置'));
    await waitFor(() => expect(screen.getByTestId('session-execution-settings').getAttribute('open')).not.toBeNull());
    expect(api.providers.models).not.toHaveBeenCalled();
    expect(screen.getByText(/^实际报告：/).textContent).toContain('Ultracode 未确认');
  });
  it('distinguishes saved launch permissions from the observed runtime permission mode', async () => {
    const withPermissions = { ...snapshot, execution: { ...snapshot.execution!,
      permissionRequest: { mode: 'acceptEdits', allowedRuleCount: 2, deniedRuleCount: 1 }, observed: { permissionMode: 'default' },
    } };
    vi.mocked(claudeExecutionSettingsApi.read).mockResolvedValue(response(withPermissions));
    render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="shell" />);
    await waitFor(() => expect(screen.getByText('启动权限：acceptEdits；请求允许/拒绝规则 2/1')).toBeTruthy());
    expect(screen.getByText('实际权限模式：default')).toBeTruthy();
    expect(screen.getByText(/仅沿用已保存的权限；一次允许不会自动保留/)).toBeTruthy();
  });
  it('updates next-launch settings and preserves the existing execution snapshot', async () => {
    const updated = { ...snapshot, next: { ...snapshot.next, effort: 'high', ultracode: false, revision: 'revision-2' } };
    vi.mocked(claudeExecutionSettingsApi.update).mockResolvedValue(response(updated));
    render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="shell" />);
    await waitFor(() => expect(screen.getByLabelText('Next execution effort')).toBeTruthy());
    fireEvent.click(screen.getByText(/执行配置/));
    await waitFor(() => expect(screen.getByRole('option', { name: 'high' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Next execution effort'), { target: { value: 'high' } });
    await waitFor(() => expect(claudeExecutionSettingsApi.update).toHaveBeenCalledWith('app-fixture', {
      ...snapshot.next, effort: 'high', ultracode: false,
    }));
    expect(screen.getByText(/启动时请求/).textContent).toContain('xhigh');
    expect(screen.getByText(/下次启动有新设置/)).toBeTruthy();
  });
  it('shows unsupported-setting errors without claiming a change applied', async () => {
    vi.mocked(claudeExecutionSettingsApi.update).mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'Unsupported on this remote' } }) } as Response);
    render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="chat" />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unsupported on this remote'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });
  it('ignores a GET started before save and preserves its bound execution when another execution is latest', async () => {
    const lateRead = deferred<Response>();
    vi.mocked(claudeExecutionSettingsApi.read).mockResolvedValueOnce(response(snapshot)).mockReturnValue(lateRead.promise);
    const updated = { ...snapshot, next: { ...snapshot.next, ultracode: false, revision: 'revision-2' },
      execution: { ...snapshot.execution!, executionId: 'another-chat', surface: 'chat' as const } };
    vi.mocked(claudeExecutionSettingsApi.update).mockResolvedValue(response(updated));
    render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="shell" executionId="run-fixture" />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    fireEvent.click(screen.getByText(/执行配置/));
    await waitFor(() => expect(claudeExecutionSettingsApi.read).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    await act(async () => { lateRead.resolve(response(snapshot)); await lateRead.promise; });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('run-fixture')).toBeTruthy();
    expect(screen.queryByText('another-chat')).toBeNull();
  });
  it('does not let a save from the previous session replace the newly selected session', async () => {
    const lateWrite = deferred<Response>();
    vi.mocked(claudeExecutionSettingsApi.update).mockReturnValue(lateWrite.promise);
    const view = render(<SessionExecutionSettings provider="claude" sessionId="app-fixture" surface="chat" />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox'));
    const other = { ...snapshot, sessionId: 'app-other', providerSessionId: 'native-other', execution: null,
      next: { ...snapshot.next, model: 'other-model', revision: 'other-revision' } };
    vi.mocked(claudeExecutionSettingsApi.read).mockResolvedValue(response(other));
    view.rerender(<SessionExecutionSettings provider="claude" sessionId="app-other" surface="chat" />);
    await waitFor(() => expect((screen.getByLabelText('Next execution model') as HTMLSelectElement).value).toBe('other-model'));
    await act(async () => { lateWrite.resolve(response({ ...snapshot, next: { ...snapshot.next, ultracode: false, revision: 'revision-2' } })); await lateWrite.promise; });
    expect((screen.getByLabelText('Next execution model') as HTMLSelectElement).value).toBe('other-model');
    expect(screen.queryByText('run-fixture')).toBeNull();
  });

});
