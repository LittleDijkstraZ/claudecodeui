import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import type { ComponentProps, MouseEvent, ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import type { TFunction } from 'i18next';

import { i18n as appI18n } from '@/modules/i18n';
import SidebarGroupConversationRow from '@/modules/sidebar/SidebarGroupConversationRow';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { sidebar: appI18n.getResourceBundle('en', 'sidebar') } }, interpolation: { escapeValue: false } });

function props(onSelect = (_projectId: string | null, _sessionId: string, _provider: string) => {}): ComponentProps<typeof SidebarGroupConversationRow> {
  return {
    conversation: {
      sessionId: 'session-1', provider: 'claude', projectId: 'project-elsewhere',
      projectPath: '/remote/another-folder', projectDisplayName: 'Another folder',
      sessionTitle: 'A long conversation title that should stay on one line', lastActivity: null, isArchived: true,
    },
    groupId: 'group-a', selected: true, currentTime: new Date('2026-09-07T12:00:00Z'),
    disabled: false, isDragging: false, dragRowProps: {}, dragHandleProps: {},
    canMoveUp: false, canMoveDown: true, onSelect,
    onOpenAssignment: () => {}, onRemove: () => {}, onMoveUp: () => {}, onMoveDown: () => {},
    t: i18n.getFixedT('en', 'sidebar') as TFunction,
  };
}

function clickAnchor(rowProps: ComponentProps<typeof SidebarGroupConversationRow>, options: { ctrlKey?: boolean; defaultPrevented?: boolean } = {}) {
  const element = SidebarGroupConversationRow(rowProps);
  const anchor = React.Children.toArray(element.props.children).find((child) => React.isValidElement(child) && child.type === 'a') as ReactElement<ComponentProps<'a'>>;
  assert.ok(anchor);
  let prevented = false;
  anchor.props.onClick?.({
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
    ...options, preventDefault: () => { prevented = true; },
  } as unknown as MouseEvent<HTMLAnchorElement>);
  return prevented;
}

test('compact row keeps working-folder metadata in its tooltip and preserves accessible archive state', () => {
  const { container } = render(<SidebarGroupConversationRow {...props()} />);
  const html = container.innerHTML;
  assert.match(html, /data-testid="group-conversation-row"/);
  assert.match(html, /data-group-id="group-a"/);
  assert.match(html, /data-session-id="session-1"/);
  assert.match(html, /title="[^"]*\/remote\/another-folder/);
  assert.match(html, /aria-label="Archived"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /min-w-0 flex-1 truncate/);
  const visibleText = html.replace(/<[^>]+>/g, '');
  assert.doesNotMatch(visibleText, /Another folder|\/remote\/another-folder/);
});

test('ordinary row click routes using the conversation’s own project and provider', () => {
  const calls: unknown[][] = [];
  const prevented = clickAnchor(props((...args) => calls.push(args)));
  assert.equal(prevented, true);
  assert.deepEqual(calls, [['project-elsewhere', 'session-1', 'claude']]);
});

test('a drag-suppressed click never opens the conversation', () => {
  const calls: unknown[][] = [];
  assert.equal(clickAnchor(props((...args) => calls.push(args)), { defaultPrevented: true }), false);
  assert.deepEqual(calls, []);
});

test('modified anchor clicks preserve browser navigation behavior', () => {
  const calls: unknown[][] = [];
  assert.equal(clickAnchor(props((...args) => calls.push(args)), { ctrlKey: true }), false);
  assert.deepEqual(calls, []);
});

test('running takes priority over unread until completion without losing the single-line controls', () => {
  const base = { ...props(), selected: false, isProcessing: true, needsAttention: true };
  const { container, rerender } = render(<SidebarGroupConversationRow {...base} />);
  const row = container.querySelector('[data-testid="group-conversation-row"]');
  assert.ok(container.querySelector('[data-session-status="running"]'));
  assert.equal(container.querySelector('[data-session-status="attention"]'), null);
  assert.ok(container.querySelector('[data-session-status="running"].text-amber-500'));
  assert.ok(container.querySelector('button[aria-haspopup="menu"]'));
  rerender(<SidebarGroupConversationRow {...base} isProcessing={false} />);
  assert.equal(container.querySelector('[data-testid="group-conversation-row"]'), row);
  assert.equal(container.querySelector('[data-session-status="running"]'), null);
  assert.ok(container.querySelector('[data-session-status="attention"].bg-green-500'));
  rerender(<SidebarGroupConversationRow {...base} />);
  assert.ok(container.querySelector('[data-session-status="running"]'));
  assert.equal(container.querySelector('[data-session-status="attention"]'), null);
  rerender(<SidebarGroupConversationRow {...base} isProcessing={false} needsAttention={false} selected />);
  assert.equal(container.querySelector('[data-testid="group-conversation-row"]'), row);
  assert.equal(container.querySelector('[data-session-status="running"]'), null);
  assert.equal(container.querySelector('[data-session-status="attention"]'), null);
  assert.ok(container.querySelector('a[aria-current="page"]'));
});

test('recent activity alone never creates an unread indicator', () => {
  const base = props();
  const { container } = render(<SidebarGroupConversationRow {...base} conversation={{ ...base.conversation, lastActivity: base.currentTime.toISOString() }} selected={false} />);
  assert.equal(container.querySelector('[data-session-status]'), null);
});


test('the conversation menu marks unread without opening the conversation', () => {
  const selected: unknown[][] = [];
  const marked: string[] = [];
  render(<SidebarGroupConversationRow {...props((...args) => selected.push(args))} onMarkSessionUnread={id => marked.push(id)} />);
  fireEvent.click(screen.getByRole('button', { name: /Options for/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }));
  assert.deepEqual(marked, ['session-1']);
  assert.deepEqual(selected, []);
});
