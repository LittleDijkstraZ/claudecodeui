import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ModelIdentitySummary from '@/modules/chat/composer/ModelIdentitySummary';
import { api, claudeExecutionSettingsApi } from '@/shared/api';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: {defaultValue?: string}) => options?.defaultValue || key }) }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionActiveModel: vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { reportedModel: 'remote-reported-exact', reportedSource: 'response' } }) })) } }, claudeExecutionSettingsApi: { read: vi.fn(async () => ({ ok: false, json: async () => ({ success: false }) })) } }));

describe('model evidence in the existing menu', () => {
  it('reads model evidence only on opening the menu and keeps the entry available without a catalog', async () => {
    render(<ComposerModelMenu effort="default" effortOptions={[]} model="selected-alias" modelOptions={[]} modelsLoading={false} onSelectEffort={vi.fn()} onSelectModel={vi.fn()}
      details={<ModelIdentitySummary provider="claude" sessionId="remote-session" selectedModel="selected-alias" revision="1" />} />);
    expect(screen.queryByTestId('model-identity-summary')).toBeNull();
    expect(api.providers.sessionActiveModel).not.toHaveBeenCalled();
    expect(claudeExecutionSettingsApi.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
    await waitFor(() => expect(screen.getByText('remote-reported-exact')).toBeTruthy());
    expect(screen.getByText('Last response:', { exact: false })).toBeTruthy();
    expect(screen.getByText('本次执行与下次启动设置')).toBeTruthy();
    expect(screen.queryByText(/执行配置 · 实际模型未确认/)).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('model-identity-summary')).toBeNull());
  });
});
