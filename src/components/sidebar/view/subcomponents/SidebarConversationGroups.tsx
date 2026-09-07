import { useEffect, useId, useState, type FormEvent, type MouseEvent } from 'react';
import { Archive, FolderInput, FolderOpen, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { useConversationGroups } from '../../../../contexts/ConversationGroupsContext';
import { ActionMenu, Button, Dialog, DialogContent, Input } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import { useGroupConversations } from '../../hooks/useGroupConversations';
import { formatCompactAge } from '../../utils/utils';

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

export default function SidebarConversationGroups({
  selectedGroupId, onSelectGroup, query, selectedSessionId, currentTime, onConversationSelect, t,
}: SidebarConversationGroupsProps) {
  const { groups, isLoading, error, refresh, openAssignment, openNewConversation, revision } = useConversationGroups();
  const [action, setAction] = useState<GroupAction | null>(null);
  const selectId = useId();
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const page = useGroupConversations(selectedGroup?.id ?? null, query, revision);

  useEffect(() => {
    // Preserve selection through WebSocket refreshes and reordering. Only pick
    // another group when the current group was actually deleted or none chosen.
    if (!isLoading && !error && !selectedGroup) {
      const next = groups[0]?.id ?? null;
      if (next !== selectedGroupId) onSelectGroup(next);
    }
  }, [error, groups, isLoading, onSelectGroup, selectedGroup, selectedGroupId]);

  const retryGroups = () => { void refresh().catch(() => {}); };

  return (
    <div className="space-y-3 px-2 py-2" data-testid="conversation-groups-view">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">{t('groups.title')}</h2>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setAction({ kind: 'create' })}>
          <Plus className="h-3.5 w-3.5" />{t('groups.create')}
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-xs">
          <p>{t('groups.loadFailed')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={retryGroups} disabled={isLoading}>
            {t('groups.retry')}
          </Button>
        </div>
      )}

      {isLoading && groups.length === 0 ? (
        <p role="status" className="px-2 py-6 text-center text-sm text-muted-foreground">{t('groups.loading')}</p>
      ) : groups.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-7 text-center">
          <Layers className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('groups.emptyTitle')}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('groups.emptyDescription')}</p>
        </div>
      ) : groups.length > 0 ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor={selectId} className="sr-only">{t('groups.choose')}</label>
            <select
              id={selectId}
              value={selectedGroup?.id ?? ''}
              onChange={(event) => onSelectGroup(event.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {!selectedGroup && <option value="" disabled>{t('groups.choose')}</option>}
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.sessionCount})</option>)}
            </select>
          </div>

          {selectedGroup && (
            <>
              <div className="rounded-lg border border-border/60 p-2.5">
                <div className="flex items-center justify-between gap-1">
                  <h3 className="min-w-0 break-words text-sm font-medium">{selectedGroup.name}</h3>
                  <ActionMenu
                    label={t('groups.manage')}
                    ariaLabel={t('groups.manageNamed', { name: selectedGroup.name })}
                    icon={MoreHorizontal}
                    iconOnly
                    portal
                    variant="ghost"
                    triggerClassName="h-8 w-8 shrink-0 p-0"
                    items={[
                      { key: 'rename', label: t('groups.rename'), icon: Pencil, onSelect: () => setAction({ kind: 'rename', id: selectedGroup.id, name: selectedGroup.name }) },
                      { key: 'delete', label: t('groups.delete'), icon: Trash2, isDanger: true, onSelect: () => setAction({ kind: 'delete', id: selectedGroup.id, name: selectedGroup.name }) },
                    ]}
                  />
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">{t('groups.acrossFolders')}</p>
                <Button type="button" variant="outline" size="sm" className="h-8 w-full text-xs" onClick={() => openNewConversation(selectedGroup.id)}>
                  <Plus className="h-3.5 w-3.5" />{t('groups.newConversation')}
                </Button>
              </div>

              <div aria-busy={page.isLoading || page.isLoadingMore || page.isRefreshing}>
                {page.isLoading ? (
                  <p role="status" className="py-6 text-center text-xs text-muted-foreground">{t('groups.loadingConversations')}</p>
                ) : !page.hasError && page.conversations.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{query.trim() ? t('groups.noMatches') : t('groups.noConversations')}</p>
                    <p className="mt-2 leading-relaxed">{query.trim() ? t('groups.trySearch') : t('groups.addHint')}</p>
                  </div>
                ) : (
                  <>
                    <p className="px-1 pb-2 text-[11px] text-muted-foreground" role="status">{t('groups.conversationCount', { count: page.total })}</p>
                    <div className="space-y-0.5">
                      {page.conversations.map((conversation) => {
                        const age = formatCompactAge(conversation.lastActivity, currentTime);
                        const selected = selectedSessionId === conversation.sessionId;
                        const open = (event: MouseEvent<HTMLAnchorElement>) => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          onConversationSelect(conversation.projectId, conversation.sessionId, conversation.provider);
                        };
                        return (
                          <div key={conversation.sessionId} className={cn('group flex min-w-0 items-center rounded-lg hover:bg-accent/60', selected && 'bg-primary/10')}>
                            <a
                              href={`/session/${encodeURIComponent(conversation.sessionId)}`}
                              onClick={open}
                              aria-current={selected ? 'page' : undefined}
                              className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              <LLMProviderLogo provider={conversation.provider} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] leading-4">{conversation.sessionTitle}</span>
                                <span className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground" title={conversation.projectPath ?? undefined}>
                                  <FolderOpen className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{conversation.projectDisplayName}</span>
                                </span>
                                <span className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                  {age && <time dateTime={conversation.lastActivity ?? undefined}>{age}</time>}
                                  {conversation.isArchived && <span className="flex items-center gap-1"><Archive className="h-2.5 w-2.5" />{t('groups.archived')}</span>}
                                </span>
                              </span>
                            </a>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="mr-1 h-8 w-8 shrink-0 p-0 text-muted-foreground"
                              title={t('groups.moveConversation')}
                              aria-label={t('groups.moveNamed', { name: conversation.sessionTitle })}
                              onClick={() => openAssignment(conversation.sessionId)}
                            ><FolderInput className="h-3.5 w-3.5" /></Button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {page.hasError && (
                  <div role="alert" className="py-3 text-center text-xs">
                    <p>{t('groups.conversationsFailed')}</p>
                    <Button type="button" variant="ghost" size="sm" onClick={page.retry}>{t('groups.retry')}</Button>
                  </div>
                )}
                {page.hasMore && !page.hasError && (
                  <Button type="button" variant="ghost" size="sm" className="mt-2 w-full text-xs" disabled={page.isLoadingMore || page.isRefreshing} onClick={page.loadMore}>
                    {page.isLoadingMore ? t('groups.loadingConversations') : t('groups.loadMore')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {action && <GroupActionDialog action={action} onClose={() => setAction(null)} onCreated={onSelectGroup} t={t} />}
    </div>
  );
}
