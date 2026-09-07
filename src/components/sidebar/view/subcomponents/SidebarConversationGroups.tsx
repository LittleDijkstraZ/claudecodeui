import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Layers, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { useConversationGroups } from '../../../../contexts/ConversationGroupsContext';
import { ActionMenu, Button, Dialog, DialogContent, Input } from '../../../../shared/view/ui';
import type { ConversationGroup } from '../../../../types/conversationGroups';
import { useGroupConversations } from '../../hooks/useGroupConversations';
import { useConversationGroupDrag } from '../../hooks/useConversationGroupDrag';

import SidebarGroupConversationRow from './SidebarGroupConversationRow';

type GroupAction = { kind: 'create' } | { kind: 'rename' | 'delete'; id: string; name: string };

type SidebarConversationGroupsProps = {
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
  query: string;
  selectedSessionId: string | null;
  currentTime: Date;
  onConversationSelect: (projectId: string | null, sessionId: string, provider: string) => void;
  t: TFunction;
};

function GroupActionDialog({
  action, onClose, onCreated, t,
}: {
  action: GroupAction;
  onClose: () => void;
  onCreated: (id: string) => void;
  t: TFunction;
}) {
  const { createGroup, renameGroup, deleteGroup } = useConversationGroups();
  const [name, setName] = useState(action.kind === 'rename' ? action.name : '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(false);
  const id = useId();
  const isDeleting = action.kind === 'delete';
  const title = t(`groups.${action.kind}`);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSaving || (!isDeleting && !name.trim())) return;
    setIsSaving(true);
    setError(false);
    try {
      if (action.kind === 'create') {
        const group = await createGroup(name.trim());
        onCreated(group.id);
      } else if (action.kind === 'rename') {
        await renameGroup(action.id, name.trim());
      } else {
        await deleteGroup(action.id);
      }
      onClose();
    } catch {
      setError(true);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isSaving) onClose(); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto p-5" aria-labelledby={`${id}-title`} aria-describedby={isDeleting ? `${id}-description` : undefined}>
        <form onSubmit={(event) => { void submit(event); }} className="space-y-4">
          <h2 id={`${id}-title`} className="text-base font-semibold">{title}</h2>
          {isDeleting ? (
            <p id={`${id}-description`} className="break-words text-sm text-muted-foreground">
              {t('groups.deleteDescription', { name: action.name })}
            </p>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor={`${id}-name`} className="text-sm">{t('groups.name')}</label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('groups.namePlaceholder')}
                maxLength={80}
                required
                disabled={isSaving}
              />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{t('groups.saveFailed')}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={isSaving} onClick={onClose}>{t('actions.cancel')}</Button>
            <Button type="submit" variant={isDeleting ? 'destructive' : 'default'} disabled={isSaving || (!isDeleting && !name.trim())}>
              {isSaving ? t('groups.saving') : isDeleting ? t('actions.delete') : t('actions.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type GroupBodyProps = Pick<SidebarConversationGroupsProps, 'query' | 'selectedSessionId' | 'currentTime' | 'onConversationSelect' | 't'> & { groupId: string };
type FailedGroupAction = { retry: () => Promise<void>; messageKey: 'groups.moveFailed' | 'groups.removeFailed' };

/** Mounted only for an expanded group, so collapsed groups perform no page requests. */
function ExpandedGroupConversations({ groupId, query, selectedSessionId, currentTime, onConversationSelect, t }: GroupBodyProps) {
  const { revision, assignSession, moveSession, openAssignment } = useConversationGroups();
  const page = useGroupConversations(groupId, query, revision);
  const [isSaving, setIsSaving] = useState(false);
  const [failedAction, setFailedAction] = useState<FailedGroupAction | null>(null);
  const pendingRef = useRef(false);

  const runAction = useCallback(async (action: () => Promise<void>, messageKey: FailedGroupAction['messageKey']) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setIsSaving(true);
    setFailedAction(null);
    try {
      await action();
    } catch (error) {
      setFailedAction({ retry: action, messageKey });
      throw error;
    } finally {
      pendingRef.current = false;
      setIsSaving(false);
    }
  }, []);

  const onMove = useCallback((movingGroupId: string, sessionId: string, targetSessionId: string, position: 'before' | 'after') => (
    runAction(() => moveSession(movingGroupId, sessionId, targetSessionId, position), 'groups.moveFailed')
  ), [moveSession, runAction]);
  const disabled = page.isLoading || page.isLoadingMore || page.isRefreshing || isSaving;
  const drag = useConversationGroupDrag({ onMove, disabled });
  const moving = disabled || drag.isMoving;

  return (
    <div data-testid="group-conversations" data-group-id={groupId} className="pb-1 pl-2" aria-busy={moving}>
      {page.isLoading ? (
        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">{t('groups.loadingConversations')}</p>
      ) : !page.hasError && page.conversations.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">{query.trim() ? t('groups.noMatches') : t('groups.noConversations')}</p>
      ) : (
        <div className="space-y-0.5">
          {page.conversations.map((conversation, index) => {
            const previous = page.conversations[index - 1];
            const next = page.conversations[index + 1];
            return (
              <SidebarGroupConversationRow
                key={conversation.sessionId}
                conversation={conversation}
                groupId={groupId}
                selected={selectedSessionId === conversation.sessionId}
                currentTime={currentTime}
                disabled={moving}
                isDragging={drag.dragState?.sessionId === conversation.sessionId}
                dropPosition={drag.dropTarget?.sessionId === conversation.sessionId ? drag.dropTarget.position : undefined}
                dragRowProps={drag.rowProps(groupId, conversation.sessionId)}
                dragHandleProps={drag.dragHandleProps(groupId, conversation.sessionId)}
                canMoveUp={Boolean(previous)}
                canMoveDown={Boolean(next)}
                onSelect={onConversationSelect}
                onOpenAssignment={() => openAssignment(conversation.sessionId)}
                onRemove={() => { void runAction(() => assignSession(conversation.sessionId, null), 'groups.removeFailed').catch(() => {}); }}
                onMoveUp={() => { if (previous) void onMove(groupId, conversation.sessionId, previous.sessionId, 'before').catch(() => {}); }}
                onMoveDown={() => { if (next) void onMove(groupId, conversation.sessionId, next.sessionId, 'after').catch(() => {}); }}
                t={t}
              />
            );
          })}
        </div>
      )}
      {failedAction && (
        <div role="alert" className="flex flex-wrap items-center gap-1 px-2 py-2 text-xs text-destructive">
          <p>{t(failedAction.messageKey)}</p>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={moving} onClick={() => { void runAction(failedAction.retry, failedAction.messageKey).catch(() => {}); }}>{t('groups.retry')}</Button>
        </div>
      )}
      {page.hasError && (
        <div role="alert" className="flex flex-wrap items-center gap-1 px-2 py-2 text-xs">
          <p>{t('groups.conversationsFailed')}</p>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={page.retry}>{t('groups.retry')}</Button>
        </div>
      )}
      {page.hasMore && !page.hasError && (
        <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 w-full text-xs text-muted-foreground" disabled={moving} onClick={page.loadMore}>
          {page.isLoadingMore ? t('groups.loadingConversations') : t('groups.loadMore')}
        </Button>
      )}
    </div>
  );
}

function ConversationGroupSection({ group, expanded, onToggle, onExpand, onAction, ...bodyProps }: Omit<GroupBodyProps, 'groupId'> & {
  group: ConversationGroup;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onAction: (action: GroupAction) => void;
}) {
  const { t } = bodyProps;
  const { openNewConversation, setGroupPinned } = useConversationGroups();
  const [pinPending, setPinPending] = useState(false);
  const [failedPinTarget, setFailedPinTarget] = useState<boolean | null>(null);
  const contentId = useId();

  const savePin = async (isPinned: boolean) => {
    if (pinPending) return;
    setPinPending(true);
    setFailedPinTarget(null);
    try {
      await setGroupPinned(group.id, isPinned);
    } catch {
      // The server may have committed despite a failed response. Retry the
      // original intent even if a subsequent refresh reports the new state.
      setFailedPinTarget(isPinned);
    } finally {
      setPinPending(false);
    }
  };

  return (
    <section data-group-id={group.id}>
      <div data-testid="group-header" data-group-id={group.id} className="flex min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-accent/50">
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={group.name}>{group.name}</span>
          {group.isPinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('groups.pinned')} />}
          <span className="text-[10px] tabular-nums text-muted-foreground/70">{group.sessionCount}</span>
        </button>
        <ActionMenu
          label={t('groups.manage')}
          ariaLabel={t('groups.manageNamed', { name: group.name })}
          icon={MoreHorizontal}
          iconOnly
          portal
          variant="ghost"
          disabled={pinPending}
          triggerClassName="h-7 w-7 shrink-0 p-0 text-muted-foreground"
          items={[
            { key: 'new-conversation', label: t('groups.newConversation'), icon: Plus, onSelect: () => { onExpand(); openNewConversation(group.id); } },
            { key: 'pin', label: t(group.isPinned ? 'groups.unpin' : 'groups.pin'), icon: group.isPinned ? PinOff : Pin, onSelect: () => { void savePin(!group.isPinned); } },
            { key: 'rename', label: t('groups.rename'), icon: Pencil, onSelect: () => onAction({ kind: 'rename', id: group.id, name: group.name }) },
            { key: 'delete', label: t('groups.delete'), icon: Trash2, showDividerBefore: true, isDanger: true, onSelect: () => onAction({ kind: 'delete', id: group.id, name: group.name }) },
          ]}
        />
      </div>
      {failedPinTarget !== null && <div role="alert" className="flex items-center gap-1 px-2 py-1 text-xs text-destructive"><span>{t('groups.pinFailed')}</span><Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={pinPending} onClick={() => { void savePin(failedPinTarget); }}>{t('groups.retry')}</Button></div>}
      {expanded && <div id={contentId}><ExpandedGroupConversations groupId={group.id} {...bodyProps} /></div>}
    </section>
  );
}

export default function SidebarConversationGroups({
  selectedGroupId, onSelectGroup, query, selectedSessionId, currentTime, onConversationSelect, t,
}: SidebarConversationGroupsProps) {
  const { groups, isLoading, error, refresh } = useConversationGroups();
  const [action, setAction] = useState<GroupAction | null>(null);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set(selectedGroupId ? [selectedGroupId] : []));
  const [searchCollapsedGroups, setSearchCollapsedGroups] = useState<Set<string>>(new Set());
  const initiallyOpened = useRef(Boolean(selectedGroupId));
  const isSearching = query.trim().length > 0;

  useEffect(() => {
    if (!selectedGroupId) return;
    initiallyOpened.current = true;
    setExpandedGroups((previous) => new Set(previous).add(selectedGroupId));
  }, [selectedGroupId]);

  useEffect(() => {
    if (initiallyOpened.current || isLoading || error || groups.length === 0) return;
    initiallyOpened.current = true;
    const firstId = groups[0].id;
    setExpandedGroups((previous) => new Set(previous).add(firstId));
    onSelectGroup(firstId);
  }, [error, groups, isLoading, onSelectGroup]);

  // Search opens every group without changing the user's ordinary expansion set.
  useEffect(() => setSearchCollapsedGroups(new Set()), [query]);

  const expandAndSelect = (groupId: string) => {
    setExpandedGroups((previous) => new Set(previous).add(groupId));
    setSearchCollapsedGroups((previous) => { const next = new Set(previous); next.delete(groupId); return next; });
    onSelectGroup(groupId);
  };

  return (
    <div className="space-y-1 px-1 py-1" data-testid="conversation-groups-view">
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <h2 className="text-[11px] font-medium text-muted-foreground">{t('groups.title')}</h2>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAction({ kind: 'create' })}>
          <Plus className="h-3.5 w-3.5" />{t('groups.create')}
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-xs">
          <p>{t('groups.loadFailed')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => { void refresh().catch(() => {}); }} disabled={isLoading}>{t('groups.retry')}</Button>
        </div>
      )}
      {isLoading && groups.length === 0 ? (
        <p role="status" className="px-2 py-6 text-center text-sm text-muted-foreground">{t('groups.loading')}</p>
      ) : groups.length === 0 && !error ? (
        <div className="px-4 py-7 text-center">
          <Layers className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('groups.emptyTitle')}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('groups.emptyDescription')}</p>
        </div>
      ) : groups.map((group) => {
        const expanded = isSearching ? !searchCollapsedGroups.has(group.id) : expandedGroups.has(group.id);
        return (
          <ConversationGroupSection
            key={group.id}
            group={group}
            expanded={expanded}
            onToggle={() => {
              if (isSearching) {
                setSearchCollapsedGroups((previous) => { const next = new Set(previous); if (expanded) next.add(group.id); else next.delete(group.id); return next; });
              } else {
                setExpandedGroups((previous) => { const next = new Set(previous); if (expanded) next.delete(group.id); else next.add(group.id); return next; });
                if (!expanded) onSelectGroup(group.id);
              }
            }}
            onExpand={() => expandAndSelect(group.id)}
            onAction={setAction}
            query={query}
            selectedSessionId={selectedSessionId}
            currentTime={currentTime}
            onConversationSelect={onConversationSelect}
            t={t}
          />
        );
      })}
      {action && <GroupActionDialog action={action} onClose={() => setAction(null)} onCreated={expandAndSelect} t={t} />}
    </div>
  );
}
