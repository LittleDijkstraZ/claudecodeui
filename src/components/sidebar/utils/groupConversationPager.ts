export type GroupConversationPage<Item> = {
  conversations: Item[];
  total: number;
  hasMore: boolean;
};

export type GroupConversationPageState<Item> = GroupConversationPage<Item> & {
  groupId: string | null;
  query: string;
  isLoading: boolean;
  isLoadingMore: boolean;
  isRefreshing: boolean;
  hasError: boolean;
};

export function emptyGroupConversationPage<Item>(): GroupConversationPageState<Item> {
  return {
    groupId: null, query: '',
    conversations: [], total: 0, hasMore: false,
    isLoading: false, isLoadingMore: false, isRefreshing: false, hasError: false,
  };
}

/** Owns pagination and request identity for the sidebar's cross-project group list. */
export function createGroupConversationPager<Item extends { sessionId: string }>(
  fetchPage: (groupId: string, options: { limit: number; offset: number; query: string }) => Promise<GroupConversationPage<Item>>,
  onChange: (state: GroupConversationPageState<Item>) => void,
) {
  let state = emptyGroupConversationPage<Item>();
  let groupId: string | null = null;
  let query = '';
  let nextOffset = 0;
  let generation = 0;
  let disposed = false;
  let failedAppend = false;
  let pendingRefresh = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (next: GroupConversationPageState<Item>) => {
    state = next;
    onChange(state);
  };

  const cancelPending = () => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const requestPage = async (append: boolean, preserveDepth = false) => {
    if (!groupId || disposed) return;
    const requestGeneration = ++generation;
    const offset = append ? nextOffset : 0;
    const targetRows = preserveDepth ? Math.max(40, nextOffset) : 40;
    const requestGroupId = groupId;
    const requestQuery = query;
    failedAppend = append;
    publish({ ...state, isLoading: !append && state.conversations.length === 0, isLoadingMore: append, isRefreshing: !append && state.conversations.length > 0, hasError: false });
    try {
      let page = await fetchPage(requestGroupId, { limit: 40, offset, query: requestQuery });
      if (disposed || generation !== requestGeneration) return;
      const rows = [...page.conversations];
      // Refresh the loaded range in ordinary server-sized pages. Keep existing
      // rows visible until the full replacement arrives, avoiding scroll jumps.
      while (preserveDepth && rows.length < targetRows && page.hasMore && page.conversations.length > 0) {
        page = await fetchPage(requestGroupId, { limit: 40, offset: rows.length, query: requestQuery });
        if (disposed || generation !== requestGeneration) return;
        rows.push(...page.conversations);
      }
      // Offset counts server rows, even if moving conversations caused duplicate
      // rows across pages. Deduplicate display without skipping later server rows.
      nextOffset = offset + rows.length;
      const conversations = append ? [...state.conversations] : [];
      const seen = new Set(conversations.map((item) => item.sessionId));
      for (const item of rows) {
        if (!seen.has(item.sessionId)) {
          conversations.push(item);
          seen.add(item.sessionId);
        }
      }
      publish({
        ...page, groupId: requestGroupId, query: requestQuery,
        conversations, hasMore: page.hasMore && page.conversations.length > 0,
        isLoading: false, isLoadingMore: false, isRefreshing: false, hasError: false,
      });
    } catch {
      if (disposed || generation !== requestGeneration) return;
      publish({ ...state, isLoading: false, isLoadingMore: false, isRefreshing: false, hasError: true });
    } finally {
      if (!disposed && generation === requestGeneration && pendingRefresh) {
        pendingRefresh = false;
        void requestPage(false, true);
      }
    }
  };

  return {
    select(nextGroupId: string | null, nextQuery: string, delayMs = 0) {
      if (disposed) return;
      cancelPending();
      groupId = nextGroupId;
      query = nextQuery.trim();
      nextOffset = 0;
      pendingRefresh = false;
      publish({ ...emptyGroupConversationPage<Item>(), groupId, query, isLoading: Boolean(groupId) });
      if (!groupId) return;
      if (delayMs > 0) {
        timer = setTimeout(() => {
          timer = null;
          void requestPage(false);
        }, delayMs);
      } else {
        void requestPage(false);
      }
    },
    loadMore() {
      if (state.isLoading || state.isLoadingMore || state.isRefreshing || !state.hasMore) return;
      void requestPage(true);
    },
    retry() {
      if (!state.hasError || state.isLoading || state.isLoadingMore || state.isRefreshing) return;
      void requestPage(failedAppend, !failedAppend);
    },
    refresh() {
      if (state.isLoading || state.isLoadingMore || state.isRefreshing) {
        pendingRefresh = true;
        return;
      }
      void requestPage(false, true);
    },
    dispose() {
      disposed = true;
      cancelPending();
    },
  };
}
