import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canStartGroupDrag,
  createGroupDragSession,
  getGroupDragScrollDelta,
  getGroupDropTarget,
} from './conversationGroupDrag';

const source = { groupId: 'group-a', sessionId: 'source' };
const before = { groupId: 'group-a', sessionId: 'anchor', position: 'before' as const };

test('a normal click or small pointer wobble never requests a reorder', () => {
  const session = createGroupDragSession(source, { x: 20, y: 40 });
  assert.deepEqual(session.update({ x: 23, y: 44 }, before), { dragging: false, dropTarget: null });
  assert.equal(session.finish(), null);
});

test('deliberate drag emits one anchor-relative move, without needing unloaded row indexes', () => {
  const session = createGroupDragSession(source, { x: 20, y: 40 });
  assert.equal(session.update({ x: 20, y: 46 }, before).dragging, true);
  session.update({ x: 20, y: 80 }, { ...before, position: 'after' });
  assert.deepEqual(session.finish(), { ...source, targetSessionId: 'anchor', position: 'after' });
  assert.equal(session.finish(), null);
});

test('leaving a valid drop row before releasing does not reuse the previous target', () => {
  const session = createGroupDragSession(source, { x: 0, y: 0 });
  session.update({ x: 0, y: 30 }, before);
  session.update({ x: 500, y: 30 }, null);
  assert.equal(session.finish(), null);
});

test('Escape, pointer cancellation, or unmount can cancel without a later pointerup moving anything', () => {
  for (const moved of [false, true]) {
    const session = createGroupDragSession(source, { x: 0, y: 0 });
    if (moved) session.update({ x: 0, y: 30 }, before);
    session.cancel();
    assert.deepEqual(session.update({ x: 0, y: 50 }, before), { dragging: false, dropTarget: null });
    assert.equal(session.finish(), null);
  }
});

test('cross-group and self drops are rejected even if a caller supplies such a target', () => {
  for (const target of [{ ...before, groupId: 'group-b' }, { ...before, sessionId: 'source' }]) {
    const session = createGroupDragSession(source, { x: 0, y: 0 });
    assert.equal(session.update({ x: 0, y: 30 }, target).dropTarget, null);
    assert.equal(session.finish(), null);
  }
});

test('drop marker uses the hovered row midpoint and rejects hidden, own, and other-group rows', () => {
  const row = { groupId: 'group-a', sessionId: 'anchor', top: 100, height: 40 };
  assert.deepEqual(getGroupDropTarget(source, row, 119), before);
  assert.deepEqual(getGroupDropTarget(source, row, 120), { ...before, position: 'after' });
  assert.equal(getGroupDropTarget(source, null, 110), null);
  assert.equal(getGroupDropTarget(source, { ...row, height: 0 }, 110), null);
  assert.equal(getGroupDropTarget(source, { ...row, sessionId: source.sessionId }, 110), null);
  assert.equal(getGroupDropTarget(source, { ...row, groupId: 'group-b' }, 110), null);
});

const plainPointer = {
  button: 0,
  pointerType: 'mouse',
  isPrimary: true,
  isHandle: false,
  isInteractiveTarget: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

test('native modified links, middle click, menu controls, and touch row scrolling never arm a drag', () => {
  assert.equal(canStartGroupDrag(plainPointer), true);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
    assert.equal(canStartGroupDrag({ ...plainPointer, [modifier]: true }), false);
  }
  assert.equal(canStartGroupDrag({ ...plainPointer, button: 1 }), false);
  assert.equal(canStartGroupDrag({ ...plainPointer, isPrimary: false }), false);
  assert.equal(canStartGroupDrag({ ...plainPointer, isInteractiveTarget: true }), false);
  assert.equal(canStartGroupDrag({ ...plainPointer, pointerType: 'touch' }), false);
});

test('touch and pen can deliberately drag from the dedicated handle', () => {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    assert.equal(canStartGroupDrag({ ...plainPointer, pointerType, isHandle: true, isInteractiveTarget: true }), true);
  }
});

test('sidebar auto-scroll stays still centrally, accelerates near edges, and caps outside the viewport', () => {
  assert.equal(getGroupDragScrollDelta(150, 100, 300), 0);
  assert.equal(getGroupDragScrollDelta(118, 100, 300), -6);
  assert.equal(getGroupDragScrollDelta(282, 100, 300), 6);
  assert.equal(getGroupDragScrollDelta(-500, 100, 300), -12);
  assert.equal(getGroupDragScrollDelta(500, 100, 300), 12);
  assert.equal(getGroupDragScrollDelta(110, 100, 120), 0);
  assert.equal(getGroupDragScrollDelta(100, 100, 100), 0);
});
