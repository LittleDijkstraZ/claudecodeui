import type { ChatMessage } from './types';

/** A completed file modification recorded by a chat tool, not a working-tree diff. */
export interface ConversationFileChange {
  id: string;
  filePath: string;
  operation: 'edit' | 'write' | 'patch' | 'delete';
  oldContent?: string;
  newContent?: string;
  patch?: string;
  sourceMessageKey: string;
  sourceToolId?: string;
  timestamp: ChatMessage['timestamp'];
  contextLabel?: string;
}

/** Real user turns remain present even when they have no recorded modifications. */
export interface ConversationChangeTurn {
  id: string;
  label: string;
  timestamp: ChatMessage['timestamp'];
  changes: ConversationFileChange[];
}
