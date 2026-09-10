import { useEffect, useState } from 'react';

import { fetchProviderCapabilities } from '@/shared/api';
import type { LLMProvider, ProviderCapabilities } from '@/shared/types';

/**
 * Cached at module scope because the matrix is static for the life of the
 * server process and more than one part of the UI asks for it. Without this,
 * opening the sidebar would refetch it on every mount.
 */
let cachedCapabilities: Partial<Record<LLMProvider, ProviderCapabilities>> | null = null;
let inFlightRequest: Promise<Partial<Record<LLMProvider, ProviderCapabilities>>> | null = null;

async function loadCapabilities(): Promise<Partial<Record<LLMProvider, ProviderCapabilities>>> {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = (async () => {
    try {
      const byProvider = await fetchProviderCapabilities();
      cachedCapabilities = byProvider;
      return byProvider;
    } catch (error) {
      console.error('Error loading provider capabilities:', error);
      // Not cached: a transient failure should not disable affordances for the
      // rest of the session.
      return {};
    } finally {
      inFlightRequest = null;
    }
  })();

  return inFlightRequest;
}

/**
 * Reports which providers can branch a session's transcript.
 *
 * Empty until the matrix loads, so an affordance is never offered and then
 * withdrawn.
 */
export function useSessionForkingProviders(): Set<LLMProvider> {
  // Retain the loaded server capability snapshot so sidebar affordances update after the request.
  const [providers, setProviders] = useState<Set<LLMProvider>>(() => new Set());

  useEffect(() => {
    let cancelled = false;

    void loadCapabilities().then((capabilities) => {
      if (cancelled) return;
      const forkable = new Set<LLMProvider>();
      for (const row of Object.values(capabilities)) {
        if (row?.supportsSessionForking) {
          forkable.add(row.provider);
        }
      }
      setProviders(forkable);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return providers;
}
