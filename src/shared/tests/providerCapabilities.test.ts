import { afterEach, expect, it, vi } from 'vitest';

import { api, ApiRequestError, fetchProviderCapabilities } from '@/shared/api';
import type { ProviderCapabilities } from '@/shared/types';

const claude: ProviderCapabilities = {
  provider: 'claude', permissionModes: ['default'], defaultPermissionMode: 'default',
  supportsImages: true, supportsFiles: true, supportsAbort: true,
  supportsPermissionRequests: true, supportsTokenUsage: true,
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

it('decodes older capability matrices without inventing support for unreported optional features', async () => {
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(respond({ success: true, data: { providers: [
    claude, { provider: 'future-provider' },
  ] } }));
  const result = await fetchProviderCapabilities();
  expect(result).toEqual({ claude });
  expect(result.claude?.supportsSessionForking).toBeUndefined();
  expect(result.codex).toBeUndefined();
});

it('preserves HTTP error codes and allows a later request to recover', async () => {
  vi.spyOn(api.providers, 'capabilities')
    .mockResolvedValueOnce(respond({ success: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'Try later.' } }, 503))
    .mockResolvedValueOnce(respond({ success: true, data: { providers: [{ ...claude, supportsSessionForking: true }] } }));
  await expect(fetchProviderCapabilities()).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE', status: 503 });
  expect((await fetchProviderCapabilities()).claude?.supportsSessionForking).toBe(true);
});

it.each([
  { success: true, data: null },
  { success: true, data: { providers: [{ ...claude, supportsSessionForking: 'false' }] } },
  { success: true, data: { providers: [{ ...claude, permissionModes: [null] }] } },
  { success: true, data: { providers: [claude, claude] } },
])('rejects malformed matrices rather than caching an unsupported result: %j', async body => {
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(respond(body));
  await expect(fetchProviderCapabilities()).rejects.toBeInstanceOf(ApiRequestError);
});
