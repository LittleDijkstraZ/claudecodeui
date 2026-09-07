export type GroupDragSource = { groupId: string; sessionId: string };
export type GroupDropTarget = GroupDragSource & { position: 'before' | 'after' };
export type GroupDragPoint = { x: number; y: number };
export type GroupDragMove = GroupDragSource & {
  targetSessionId: string;
  position: 'before' | 'after';
};

export const GROUP_DRAG_THRESHOLD = 6;

/** Modified clicks and touch scrolling on the conversation link keep their native behavior. */
export function canStartGroupDrag(input: {
  button: number;
  pointerType: string;
  isPrimary: boolean;
  isHandle: boolean;
  isInteractiveTarget: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return input.button === 0 && input.isPrimary
    && !input.altKey && !input.ctrlKey && !input.metaKey && !input.shiftKey
    && (input.isHandle || (input.pointerType === 'mouse' && !input.isInteractiveTarget));
}

export function getGroupDropTarget(
  source: GroupDragSource,
  row: (GroupDragSource & { top: number; height: number }) | null,
  pointerY: number,
): GroupDropTarget | null {
  if (!row || row.groupId !== source.groupId || row.sessionId === source.sessionId || row.height <= 0) return null;
  return {
    groupId: row.groupId,
    sessionId: row.sessionId,
    position: pointerY < row.top + row.height / 2 ? 'before' : 'after',
  };
}

/** Edge scrolling is proportional and bounded, including in short sidebar lists. */
export function getGroupDragScrollDelta(pointerY: number, top: number, bottom: number): number {
  const edge = Math.min(36, Math.max(0, (bottom - top) / 2));
  if (edge === 0) return 0;
  if (pointerY < top + edge) return -Math.ceil(12 * Math.min(1, (top + edge - pointerY) / edge));
  if (pointerY > bottom - edge) return Math.ceil(12 * Math.min(1, (pointerY - bottom + edge) / edge));
  return 0;
}

/** A move is emitted once, only after deliberate movement and a valid same-group anchor. */
export function createGroupDragSession(source: GroupDragSource, origin: GroupDragPoint) {
  let dragging = false;
  let finished = false;
  let dropTarget: GroupDropTarget | null = null;

  return {
    get dragging() { return dragging; },
    update(point: GroupDragPoint, target: GroupDropTarget | null) {
      if (finished) return { dragging: false, dropTarget: null };
      dragging ||= Math.hypot(point.x - origin.x, point.y - origin.y) >= GROUP_DRAG_THRESHOLD;
      dropTarget = dragging && target?.groupId === source.groupId && target.sessionId !== source.sessionId
        ? target : null;
      return { dragging, dropTarget };
    },
    finish(): GroupDragMove | null {
      if (finished) return null;
      finished = true;
      return dragging && dropTarget
        ? { ...source, targetSessionId: dropTarget.sessionId, position: dropTarget.position }
        : null;
    },
    cancel() {
      finished = true;
      dropTarget = null;
    },
  };
}
