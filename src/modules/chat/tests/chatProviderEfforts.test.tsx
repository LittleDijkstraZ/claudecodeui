import assert from 'node:assert/strict';

import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { i18n as appI18n } from '@/modules/i18n';
import { resetUserPreferences } from '@/shared/userSettings';
import type { ProviderModelOption } from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

const mocks = vi.hoisted(() => ({ models: vi.fn() }));
vi.mock('@/shared/api', () => ({
  fetchProviderCapabilities: async () => ({}),
  api: {
    user: {
      preferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: {} }) }),
      savePreferences: async () => ({ ok: true, json: async () => ({ success: true, preferences: {} }) }),
    },
    providers: {
      models: mocks.models,
      capabilities: async () => ({ ok: true, json: async () => ({ success: true, data: null }) }),
    },
  },
}));

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: appI18n.getResourceBundle('en', 'chat') } }, interpolation: { escapeValue: false } });
const model = 'claude-fable-5-1[1m]';
const option = (value = model, efforts = ['high', 'xhigh', 'ultracode']): ProviderModelOption => ({
  value, label: value, selectionKind: 'version', contextMode: value.endsWith('[1m]') ? '1m' : 'default',
  effort: { values: efforts.map(value => ({ value })) },
});
const catalog = (options: ProviderModelOption[]) => ({ ok: true, json: async () => ({ success: true, data: { models: { OPTIONS: options, DEFAULT: 'default' } } }) });

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  localStorage.setItem('claude-model', model);
  localStorage.setItem('claude-effort', 'ultracode');
  mocks.models.mockReset();
});

function MenuHarness() {
  const state = useChatProviderState({ selectedSession: null, selectedProject: null });
  return <I18nextProvider i18n={i18n}>
    <ComposerModelMenu model={state.currentProviderModel} effort={state.currentProviderEffort}
      modelOptions={state.currentProviderModelOptions} effortOptions={state.currentProviderEffortOptions}
      modelsLoading={state.providerModelsLoading} details={<span>Model settings</span>}
      onSelectModel={() => {}} onSelectEffort={effort => { void state.selectProviderEffort('claude', effort); }} />
  </I18nextProvider>;
}

test('a pending Claude catalog offers no invented efforts and preserves a saved Ultracode until support arrives', async () => {
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  const pending = new Promise<ReturnType<typeof catalog>>(accept => { resolve = accept; });
  mocks.models.mockImplementation((provider: string) => provider === 'claude' ? pending : Promise.resolve(catalog([])));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  assert.equal(result.current.providerModelsLoading, true);
  assert.equal(result.current.currentProviderEffortOptions.length, 0);
  assert.equal(result.current.currentProviderEffort, 'ultracode');
  await act(async () => resolve(catalog([option()])));
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.deepEqual(result.current.currentProviderEffortOptions.map(item => item.value), ['high', 'xhigh', 'ultracode']);
  assert.equal(result.current.currentProviderEffort, 'ultracode');
  assert.equal(localStorage.getItem('claude-effort'), 'ultracode');
});

test('a pinned unknown context ID never inherits the provider fallback or another variant’s effort support', async () => {
  mocks.models.mockResolvedValue(catalog([option('claude-fable-5-1')]));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.currentProviderModel, model);
  assert.equal(result.current.currentProviderEffortOptions.length, 0);
  assert.equal(result.current.currentProviderEffort, 'ultracode');
  assert.equal(localStorage.getItem('claude-effort'), 'ultracode');
});

test('catalog failure preserves the requested effort without advertising unconfirmed selections', async () => {
  mocks.models.mockRejectedValue(new Error('Remote unavailable'));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.currentProviderEffortOptions.length, 0);
  assert.equal(result.current.currentProviderEffort, 'ultracode');
  assert.equal(localStorage.getItem('claude-effort'), 'ultracode');
});

test('an unconfirmed saved effort stays visible with a warning and can be explicitly cleared to Remote default', async () => {
  mocks.models.mockResolvedValue(catalog([]));
  render(<MenuHarness />);
  const trigger = screen.getByRole('button', { name: 'Select model and reasoning effort' });
  assert.match(trigger.textContent ?? '', /Ultracode/);
  fireEvent.click(trigger);
  assert.match((await screen.findByRole('status')).textContent ?? '', /Ultracode is saved.*not confirmed support/);
  assert.equal(screen.queryByRole('menuitemradio', { name: /^Ultracode/ }), null);
  assert.equal(localStorage.getItem('claude-effort'), 'ultracode');
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Remote default' }));
  await waitFor(() => assert.equal(localStorage.getItem('claude-effort'), 'default'));
  assert.equal(screen.queryByRole('status'), null);
});

test('a supported model exposes exactly its reported efforts and selecting Ultracode still works', async () => {
  localStorage.setItem('claude-effort', 'high');
  mocks.models.mockResolvedValue(catalog([option()]));
  render(<MenuHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  const ultracode = await screen.findByRole('menuitemradio', { name: /^Ultracode/ });
  assert.equal(screen.queryByRole('status'), null);
  assert.equal(screen.queryByRole('menuitemradio', { name: 'max' }), null);
  fireEvent.click(ultracode);
  await waitFor(() => assert.equal(localStorage.getItem('claude-effort'), 'ultracode'));
  assert.match(screen.getByRole('button', { name: 'Select model and reasoning effort' }).textContent ?? '', /Ultracode/);
});

test('a reported model that no longer lists the saved effort offers supported choices without silently downgrading', async () => {
  mocks.models.mockResolvedValue(catalog([option(model, ['low', 'high'])]));
  render(<MenuHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  await screen.findByRole('status');
  assert.ok(screen.getByRole('menuitemradio', { name: 'high' }));
  assert.equal(screen.queryByRole('menuitemradio', { name: /^Ultracode/ }), null);
  assert.equal(localStorage.getItem('claude-effort'), 'ultracode');
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
  await waitFor(() => assert.equal(localStorage.getItem('claude-effort'), 'high'));
});
