import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Expand } from 'lucide-react';

import { useTheme } from '../../../../../contexts/ThemeContext';

import MermaidViewer from './MermaidViewer';

// Mermaid is ~1.5MB minified, so it is loaded on demand the first time a
// diagram is rendered and shared by every instance afterwards.
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null;
const loadMermaid = () => {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
};

type MermaidDiagramProps = {
  /** Raw mermaid source, i.e. the body of a ```mermaid fenced block. */
  code: string;
};

/**
 * Renders a ```mermaid code block as an SVG diagram, GitHub-preview style.
 *
 * While mermaid is loading — or when the source doesn't parse (e.g. a block
 * that is still streaming in) — the raw source is shown instead, so the
 * content is never blank or replaced by an error box.
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const { t } = useTranslation('codeEditor');
  const previewRef = useRef<HTMLButtonElement>(null);
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null);
  const closeViewer = useCallback(() => setExpandedHeight(null), []);
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkMode ? 'dark' : 'default',
          suppressErrorRendering: true,
        });
        return mermaid.render(renderId, code.trim());
      })
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
        }
        // suppressErrorRendering still leaves the scratch element behind on
        // parse failures in some mermaid versions; clean it up.
        document.getElementById(`d${renderId}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode, reactId]);

  if (!svg) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
        {code.trim()}
      </pre>
    );
  }

  return (
    <>
      <button
        ref={previewRef}
        type="button"
        aria-label={t('mermaid.open')}
        title={t('mermaid.open')}
        className="group relative my-3 flex w-full cursor-zoom-in justify-center overflow-x-auto rounded-xl border border-border bg-white p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:bg-zinc-900 [&_svg]:h-auto [&_svg]:max-w-full"
        style={expandedHeight === null ? undefined : { height: expandedHeight }}
        onClick={() => setExpandedHeight(previewRef.current?.getBoundingClientRect().height ?? 160)}
        data-testid="mermaid-preview"
      >
        {/* Keep one copy of Mermaid's SVG IDs in the document while inspecting it. */}
        {expandedHeight === null && <span className="block w-full [&_svg]:mx-auto" dangerouslySetInnerHTML={{ __html: svg }} />}
        <span className="pointer-events-none absolute right-2 top-2 rounded-md border border-border bg-background/90 p-1.5 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true"><Expand className="h-4 w-4" /></span>
      </button>
      {expandedHeight !== null && <MermaidViewer svg={svg} onClose={closeViewer} />}
    </>
  );
}
