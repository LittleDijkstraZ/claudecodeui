/** Exact tool-record destination; requestId makes repeated jumps reopen collapsed content. */
export type MessageRevealTarget = {
  messageKey: string;
  toolId?: string;
  requestId: number;
};
