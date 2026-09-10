import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileCode2, History, Loader2, MessageSquare, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/shared/ui';
import type { ConversationChangeTurn, ConversationFileChange, DiffCalculator } from '@/shared/types';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { createConversationChangeStats } from '@/modules/chat/utils/conversationChangeStats';
import ConversationChangeContent from '@/modules/chat/changes/ConversationChangeContent';

type ConversationChangesBarProps = {
  turns: ConversationChangeTurn[];
  isProcessing: boolean;
  hasEarlierMessages: boolean;
  isLoadingEarlierMessages: boolean;
  onLoadAllMessages: () => Promise<ConversationChangeTurn[]>;
  onJumpToChange: (change: ConversationFileChange) => void;
};

type ChangeRecord = { change: ConversationFileChange; turn: ConversationChangeTurn };
type FileChanges = { path: string; records: ChangeRecord[] };

function formattedTime(value: unknown, language: string) {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ChangeRecordView({ record, index, createDiff, onJump, showTurn }: {
  record: ChangeRecord;
  index: number;
  createDiff: DiffCalculator;
  onJump: (change: ConversationFileChange) => void;
  showTurn: boolean;
}) {
  const { t, i18n } = useTranslation('chat');
  const { change, turn } = record;
  const size = (change.oldContent?.length ?? 0) + (change.newContent?.length ?? 0) + (change.patch?.length ?? 0);
  // Keep the user's expansion choice while the underlying change records refresh.
  const [expanded, setExpanded] = useState(index < 3 && size <= 40_000);
  const contentId = useId();
  const time = formattedTime(change.timestamp, i18n.resolvedLanguage ?? 'en');

  return (
    <article className="space-y-2 rounded-lg bg-muted/20 p-2.5 sm:p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <span>{t('changes.editNumber', { number: index + 1 })}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-normal text-muted-foreground">{t(`changes.operation.${change.operation}`)}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          aria-label={t('changes.jumpNamed', { file: change.filePath, number: index + 1 })}
          onClick={() => onJump(change)}
        >
          <MessageSquare className="h-3 w-3" />{t('changes.jump')}
        </Button>
      </div>
      {(showTurn || change.contextLabel || time) && (
        <p className="break-words text-[11px] leading-relaxed text-muted-foreground">
          {showTurn && <span>{turn.label}{time ? ' · ' : ''}</span>}
          {time && <span>{time}</span>}
          {change.contextLabel && <span className="mt-0.5 block">{change.contextLabel}</span>}
        </p>
      )}
      {expanded ? (
        <div id={contentId}>
          <ConversationChangeContent change={change} createDiff={createDiff} />
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setExpanded(true)} aria-controls={contentId}>
          {t('changes.showEdit')}
        </Button>
      )}
    </article>
  );
}

function FileChangeGroup({ file, defaultExpanded, createDiff, onJump, showTurn }: {
  file: FileChanges;
  defaultExpanded: boolean;
  createDiff: DiffCalculator;
  onJump: (change: ConversationFileChange) => void;
  showTurn: boolean;
}) {
  const { t } = useTranslation('chat');
  // Keep the user's expansion choice while the underlying change records refresh.
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Bound the rendered edit cards until the user requests more records.
  const [visibleEdits, setVisibleEdits] = useState(10);
  const contentId = useId();

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{file.path}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{t('changes.editCount', { count: file.records.length })}</span>
      </button>
      {expanded && (
        <div id={contentId} className="space-y-2 border-t border-border p-2 sm:p-3">
          {file.records.length > 1 && <p className="px-1 pb-1 text-[11px] text-muted-foreground">{t('changes.sequentialEdits')}</p>}
          {file.records.slice(0, visibleEdits).map((record, index) => (
            <ChangeRecordView key={record.change.id} record={record} index={index} createDiff={createDiff} onJump={onJump} showTurn={showTurn} />
          ))}
          {file.records.length > visibleEdits && (
            <Button type="button" variant="ghost" size="sm" className="w-full text-xs" onClick={() => setVisibleEdits((count) => count + 10)}>
              {t('changes.moreEdits', { count: file.records.length - visibleEdits })}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Used by chat's ChatInterface to summarize recorded edits and reveal their original context. */
export default function ConversationChangesBar({
  turns, isProcessing, hasEarlierMessages, isLoadingEarlierMessages, onLoadAllMessages, onJumpToChange,
}: ConversationChangesBarProps) {
  const { t, i18n } = useTranslation('chat');
  // Keep the changes review dialog open independently of streamed chat updates.
  const [isOpen, setIsOpen] = useState(false);
  // Select the current turn, an earlier turn, or all loaded changes for review.
  const [selectedScope, setScope] = useState('latest');
  // Limit initial file card rendering for conversations with many edits.
  const [visibleFiles, setVisibleFiles] = useState(40);
  // A covering dialog pauses the background chat subscription, so retain its explicit history result here.
  const [loadedTurns, setLoadedTurns] = useState<ConversationChangeTurn[] | null>(null);
  // Give the dialog immediate feedback independently of the background transcript's render window.
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // Keep a failed history request visible so the same action can be retried.
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const id = useId();
  const pendingJumpRef = useRef<number | null>(null);
  const historyRequestRef = useRef<symbol | null>(null);
  const onJumpRef = useRef(onJumpToChange);
  useLayoutEffect(() => { onJumpRef.current = onJumpToChange; }, [onJumpToChange]);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const countStats = useMemo(() => createConversationChangeStats(createDiff), [createDiff]);
  const reviewTurns = loadedTurns ?? turns;
  const loadingHistory = isLoadingHistory || isLoadingEarlierMessages;
  const latestTurn = reviewTurns[reviewTurns.length - 1];
  const latestChangedTurn = [...reviewTurns].reverse().find((turn) => turn.changes.length > 0);
  // Rewind or authoritative identity reconciliation can replace turn IDs.
  // A vanished selection must not leave a false empty Review over fresh history.
  const scope = selectedScope === 'latest' || selectedScope === 'all' || reviewTurns.some(turn => `turn:${turn.id}` === selectedScope)
    ? selectedScope : 'latest';
  const latestFileCount = new Set(latestTurn?.changes.map((change) => change.filePath) ?? []).size;
  const allEditCount = reviewTurns.reduce((count, turn) => count + turn.changes.length, 0);

  const files = useMemo(() => {
    const selectedTurns = scope === 'all'
      ? reviewTurns
      : scope === 'latest'
        ? latestTurn ? [latestTurn] : []
        : reviewTurns.filter((turn) => `turn:${turn.id}` === scope);
    const byFile = new Map<string, FileChanges>();
    for (const turn of selectedTurns) {
      for (const change of turn.changes) {
        const file = byFile.get(change.filePath) ?? { path: change.filePath, records: [] };
        file.records.push({ change, turn });
        byFile.set(change.filePath, file);
      }
    }
    return [...byFile.values()];
  }, [latestTurn, scope, reviewTurns]);
  const selectedEditCount = files.reduce((count, file) => count + file.records.length, 0);
  const totals = useMemo(() => countStats(files.flatMap(file => file.records.map(record => record.change))), [countStats, files]);
  const scopeLabel = scope === 'latest' ? t(isProcessing ? 'changes.currentTurn' : 'changes.latestTurn')
    : scope === 'all' ? t('changes.allLoaded') : reviewTurns.find(turn => `turn:${turn.id}` === scope)?.label ?? t('changes.scope');
  const statsDescription = `${scopeLabel} · ${totals.known > 0 ? t('changes.lineTotals', { added: totals.added, removed: totals.removed }) : t('changes.lineTotalsUnavailable')}${totals.unknown > 0 ? ` ${t('changes.lineTotalsIncomplete')}` : ''}`;
  const lineTotals = selectedEditCount > 0 ? (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] font-medium tabular-nums" title={statsDescription} aria-label={statsDescription} data-testid="conversation-change-totals">
      <span className="text-green-700 dark:text-green-400" aria-hidden="true">+{totals.known > 0 ? totals.added.toLocaleString(i18n.resolvedLanguage) : '?'}</span>
      <span className="text-red-700 dark:text-red-400" aria-hidden="true">−{totals.known > 0 ? totals.removed.toLocaleString(i18n.resolvedLanguage) : '?'}</span>
      {totals.unknown > 0 && <span className="font-sans font-normal text-muted-foreground" aria-hidden="true">{t(totals.known > 0 ? 'changes.lineTotalsPartial' : 'changes.lineTotalsUnknown')}</span>}
    </span>
  ) : null;

  useEffect(() => () => {
    historyRequestRef.current = null;
    if (pendingJumpRef.current !== null) cancelAnimationFrame(pendingJumpRef.current);
  }, []);

  const changeOpen = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // A closed or replaced review must not consume a late result on its next opening.
      historyRequestRef.current = null;
      setIsLoadingHistory(false);
      setHistoryLoadFailed(false);
      setLoadedTurns(null);
    }
  };

  const loadHistory = async () => {
    if (historyRequestRef.current || loadingHistory) return;
    const request = Symbol('changes-history');
    historyRequestRef.current = request;
    setIsLoadingHistory(true);
    setHistoryLoadFailed(false);
    try {
      const fullTurns = await onLoadAllMessages();
      if (historyRequestRef.current !== request) return;
      setLoadedTurns(fullTurns);
      setScope('all');
      setVisibleFiles(40);
    } catch {
      if (historyRequestRef.current === request) setHistoryLoadFailed(true);
    } finally {
      if (historyRequestRef.current === request) {
        historyRequestRef.current = null;
        setIsLoadingHistory(false);
      }
    }
  };

  const jump = (change: ConversationFileChange) => {
    // Close the portal and let its focus restoration finish before the parent
    // expands the original tool card and scrolls to it in the conversation.
    flushSync(() => changeOpen(false));
    pendingJumpRef.current = requestAnimationFrame(() => {
      pendingJumpRef.current = null;
      onJumpRef.current(change);
    });
  };

  if (!isOpen && allEditCount === 0 && !hasEarlierMessages) return null;

  return (
    <Dialog open={isOpen} onOpenChange={changeOpen}>
      <div className="mx-auto mb-1 flex w-[calc(100%_-_1rem)] max-w-[54.25rem] justify-end sm:w-[calc(100%_-_2rem)]" data-testid="conversation-changes-bar">
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-6 max-w-full gap-1.5 px-2 text-[11px] text-muted-foreground" title={t('changes.review')}>
            <FileCode2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('changes.review')}{scope !== 'latest' ? ` · ${scopeLabel} · ${t('changes.fileCount', { count: files.length })}` : latestFileCount > 0 ? ` · ${t('changes.latestFiles', { count: latestFileCount })}` : allEditCount > 0 ? ` · ${t('changes.earlierEdits', { count: allEditCount })}` : ''}</span>
            {lineTotals}
            {isProcessing && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label={t('changes.processing')} />}
          </Button>
        </DialogTrigger>
      </div>

      <DialogContent className="flex max-h-[90dvh] w-[calc(100%_-_1rem)] max-w-4xl flex-col overflow-hidden sm:w-[calc(100%_-_3rem)]" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
        <div className="shrink-0 space-y-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle id={`${id}-title`} className="not-sr-only text-base font-semibold">{t('changes.title')}</DialogTitle>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label={t('changes.close')} onClick={() => changeOpen(false)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 sm:max-w-md">
              <label htmlFor={`${id}-scope`} className="sr-only">{t('changes.scope')}</label>
              <select
                id={`${id}-scope`}
                value={scope}
                onChange={(event) => { setScope(event.target.value); setVisibleFiles(40); }}
                className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="latest">{t(isProcessing ? 'changes.currentTurn' : 'changes.latestTurn')}</option>
                <option value="all">{t('changes.allLoaded')}</option>
                {reviewTurns.slice(0, -1).reverse().map((turn) => (
                  <option key={turn.id} value={`turn:${turn.id}`}>
                    {turn.label.slice(0, 100)}{turn.timestamp ? ` · ${formattedTime(turn.timestamp, i18n.resolvedLanguage ?? 'en')}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status"><span>{t('changes.fileCount', { count: files.length })} · {t('changes.editCount', { count: selectedEditCount })}</span>{lineTotals}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-5">
          {files.length === 0 ? (
            <div className="py-10 text-center">
              <FileCode2 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
              <p className="text-sm">{t('changes.noChanges')}</p>
              {scope === 'latest' && latestChangedTurn && latestChangedTurn !== latestTurn && (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setScope(`turn:${latestChangedTurn.id}`)}>{t('changes.viewPrevious')}</Button>
              )}
            </div>
          ) : files.slice(0, visibleFiles).map((file, index) => (
            <FileChangeGroup key={`${scope}:${file.path}`} file={file} defaultExpanded={index < 5} createDiff={createDiff} onJump={jump} showTurn={scope === 'all'} />
          ))}
          {files.length > visibleFiles && (
            <Button type="button" variant="outline" className="w-full text-xs" onClick={() => setVisibleFiles((count) => count + 40)}>{t('changes.moreFiles', { count: files.length - visibleFiles })}</Button>
          )}
        </div>

        <div className="shrink-0 space-y-2 border-t border-border bg-muted/15 px-4 py-3 sm:px-5">
          {((hasEarlierMessages && loadedTurns === null) || loadingHistory || historyLoadFailed) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('changes.partialHistory')}</p>
              <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={loadingHistory} onClick={() => { void loadHistory(); }}>
                {loadingHistory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                {t(loadingHistory ? 'changes.loadingHistory' : 'changes.loadHistory')}
              </Button>
            </div>
          )}
          {historyLoadFailed && <p role="alert" className="text-xs text-destructive">{t('changes.loadHistoryFailed')}</p>}
          <p id={`${id}-description`} className="text-[11px] leading-relaxed text-muted-foreground">{t('changes.recordedOnly')}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
