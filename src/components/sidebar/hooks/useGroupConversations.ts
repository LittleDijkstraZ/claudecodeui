import { useEffect, useRef, useState } from 'react';

import { listGroupConversations } from '../../../utils/conversationGroupsApi';
import { createGroupConversationPager, emptyGroupConversationPage } from '../utils/groupConversationPager';

type GroupConversation = Awaited<ReturnType<typeof listGroupConversations>>['conversations'][number];

export function useGroupConversations(groupId: string | null, query: string, revision: number) {
  const [page, setPage] = useState(emptyGroupConversationPage<GroupConversation>);
  const pagerRef = useRef<ReturnType<typeof createGroupConversationPager<GroupConversation>> | null>(null);
  const revisionRef = useRef(revision);

  useEffect(() => {
    const pager = createGroupConversationPager(listGroupConversations, setPage);
    pagerRef.current = pager;
    // Disposing invalidates both pending search timers and in-flight requests.
    return () => pager.dispose();
  }, []);

  useEffect(() => {
    pagerRef.current?.select(groupId, query, query.trim() ? 250 : 0);
  }, [groupId, query]);

  useEffect(() => {
    if (revisionRef.current !== revision) pagerRef.current?.refresh();
    revisionRef.current = revision;
  }, [revision]);

  return {
    // A render can select B before its effect runs; never show A under B's header.
    ...(page.groupId === groupId && page.query === query.trim()
      ? page
      : { ...emptyGroupConversationPage<GroupConversation>(), isLoading: Boolean(groupId) }),
    loadMore: () => pagerRef.current?.loadMore(),
    retry: () => pagerRef.current?.retry(),
  };
}
