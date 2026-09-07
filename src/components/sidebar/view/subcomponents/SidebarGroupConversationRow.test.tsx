import assert from 'node:assert/strict';
import test from 'node:test';

import React, { type ComponentProps, type MouseEvent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance, type TFunction } from 'i18next';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';

import SidebarGroupConversationRow from './SidebarGroupConversationRow';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { sidebar: enSidebar } }, interpolation: { escapeValue: false } });

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
  const html = renderToStaticMarkup(<SidebarGroupConversationRow {...props()} />);
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
