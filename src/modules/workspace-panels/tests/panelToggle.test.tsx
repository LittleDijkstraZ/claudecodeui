import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { WorkspacePanelsProvider, useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';

function Harness() {
  const actions = useWorkspacePanelActions(); const panel = useWorkspacePanels();
  const [draft, setDraft] = useState('');
  return <><button onClick={() => actions?.togglePanel('shell')}>Shell</button><button onClick={() => actions?.togglePanel('files')}>Files</button><button onClick={() => actions?.openPanel('shell')}>Open shell explicitly</button>
    <button onClick={() => actions?.collapsePanel()}>Collapse</button><output>{`${panel?.open}:${panel?.tab}:${[...(panel?.visited ?? [])].join(',')}`}</output><textarea aria-label="retained terminal" value={draft} onChange={event => setDraft(event.target.value)} /></>;
}
test('repeat tab selection keeps the panel open and explicit collapse retains content', () => {
  render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
  const terminal = screen.getByLabelText('retained terminal');
  fireEvent.change(terminal, { target: { value: 'in progress' } });
  fireEvent.click(screen.getByText('Shell')); expect(screen.getByRole('status').textContent).toBe('true:shell:shell');
  fireEvent.click(screen.getByText('Shell')); expect(screen.getByRole('status').textContent).toBe('true:shell:shell');
  fireEvent.click(screen.getByText('Files')); expect(screen.getByRole('status').textContent).toBe('true:files:shell,files');
  fireEvent.click(screen.getByText('Open shell explicitly')); fireEvent.click(screen.getByText('Open shell explicitly'));
  expect(screen.getByRole('status').textContent).toBe('true:shell:shell,files');
  fireEvent.click(screen.getByText('Collapse')); expect(screen.getByRole('status').textContent).toBe('false:shell:shell,files');
  expect(screen.getByLabelText('retained terminal')).toBe(terminal); expect((terminal as HTMLTextAreaElement).value).toBe('in progress');
});
