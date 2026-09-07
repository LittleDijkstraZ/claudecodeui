import { createContext, useContext } from 'react';

import type { ChatMessage } from '../types/types';

import type { ClaudeSessionCapabilities } from './claudeSessionActionsApi';

type ClaudeSessionActions = {
  enabled: boolean;
  capabilities: ClaudeSessionCapabilities | null;
  busy: boolean;
  status: string | null;
  isSavedMessage: (message: ChatMessage, userOnly?: boolean) => boolean;
  open: (type: 'sideChat' | 'rewind', message: ChatMessage) => void;
  refresh: () => void;
};

export const ClaudeSessionActionsContext = createContext<ClaudeSessionActions | null>(null);

export function useClaudeSessionActions() {
  return useContext(ClaudeSessionActionsContext);
}
