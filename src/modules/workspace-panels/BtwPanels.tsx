import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';

import { askClaudeBtw } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { ClaudeBtwHistoryTurn, WorkspaceBtwTab } from '@/shared/types';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels/context/WorkspacePanelsContext';

type BtwTurn = { question: string; answer?: string; error?: string };

// Bound follow-up payloads while leaving every exchange visible in the tab.
function followupHistory(turns: BtwTurn[]) {
  const completed = turns.filter(turn => turn.answer);
  const history: ClaudeBtwHistoryTurn[] = [];
  let remaining = 64000;
  let limited = false;
  for (const turn of completed.slice().reverse()) {
    const response = turn.answer!;
    if (history.length === 32 || turn.question.length + response.length > remaining) {
      // Even one unusually long response should still support a follow-up.
      if (!history.length) history.unshift({ question: turn.question, response: response.slice(0, remaining - turn.question.length - 1) + '…' });
      limited = true;
      break;
    }
    history.unshift({ question: turn.question, response });
    remaining -= turn.question.length + response.length;
  }
  return { history, limited };
}

function BtwPanel({ tab, visible }: { tab: WorkspaceBtwTab; visible: boolean }) {
  const { t } = useTranslation('common');
  const actions = useWorkspacePanelActions();
  // Each mounted tab retains its own next-question draft until explicitly closed.
  const [question, setQuestion] = useState('');
  // Retain completed exchanges and the pending/failed turn only in this tab's memory.
  const [turns, setTurns] = useState<BtwTurn[]>([]);
  const pending = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const last = turns.at(-1);
  const loading = Boolean(last && last.answer === undefined && last.error === undefined);
  const { history, limited } = followupHistory(turns);
  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    if (visible && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [turns, visible]);
  useEffect(() => { if (visible && !loading) composer.current?.focus(); }, [visible, loading]);
  const submit = async (retry = false) => {
    const text = retry ? last?.question : question.trim();
    if (!text || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const previous = last?.error ? turns.slice(0, -1) : turns;
    setTurns([...previous, { question: text }]);
    if (!retry) setQuestion('');
    if (!previous.length) actions?.renameBtw(tab.id, `BTW · ${text.replace(/\s+/g, ' ').slice(0, 36)}`);
    try {
      const { answer } = await askClaudeBtw(tab.sessionId, text, controller.signal, history);
      if (!controller.signal.aborted) setTurns([...previous, { question: text, answer }]);
    } catch (error) {
      if (!controller.signal.aborted) setTurns([...previous, { question: text, error: error instanceof Error ? error.message : String(error) }]);
    } finally { if (pending.current === controller) pending.current = null; }
  };
  return <section hidden={!visible} className={`h-full min-h-0 flex-col ${visible ? 'flex' : 'hidden'}`} aria-label={tab.label}>
    <div className="shrink-0 border-b border-border px-4 py-3">
      <p className="truncate text-xs font-medium" title={tab.sourceLabel}>{tab.sourceLabel}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('btw.description')}</p>
      {limited && <p className="mt-1 text-xs text-muted-foreground">{t('btw.contextLimited')}</p>}
    </div>
    <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
      {!turns.length && <p className="text-sm text-muted-foreground">{t('btw.empty')}</p>}
      {turns.map((turn, index) => <div key={index} className="mb-6 space-y-4">
        <p className="whitespace-pre-wrap break-words rounded-xl bg-accent px-4 py-3 text-sm">{turn.question}</p>
        {turn.answer !== undefined && <div className="prose prose-sm max-w-none break-words dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.answer}</ReactMarkdown></div>}
        {turn.error !== undefined && <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{turn.error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => { void submit(true); }}>{t('btw.retry')}</Button>
        </div>}
      </div>)}
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('btw.thinking')}</p>}
    </div>
    <form className="flex shrink-0 items-end gap-2 border-t border-border p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea ref={composer} aria-label={t('btw.question')} placeholder={t(history.length ? 'btw.followupPlaceholder' : 'btw.placeholder')} value={question} onChange={event => setQuestion(event.target.value)} maxLength={16000} rows={3}
        className="min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); } }} />
      <Button type="submit" size="icon" disabled={!question.trim() || loading} aria-label={t('btw.send')}><Send className="h-4 w-4" /></Button>
    </form>
  </section>;
}

/** Used by project-workspace to retain independent, disposable native /btw exchanges across navigation. */
export function BtwPanels() {
  const panel = useWorkspacePanels();
  return <>{panel?.btwTabs.map(tab => <BtwPanel key={tab.id} tab={tab} visible={panel.open && panel.tab === tab.id} />)}</>;
}
