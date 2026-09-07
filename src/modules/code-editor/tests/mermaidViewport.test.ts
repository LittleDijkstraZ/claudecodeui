import assert from 'node:assert/strict';

import { test } from 'vitest';

import { centerDiagram, fitDiagram, pinchDiagram, zoomDiagramAt } from '@/modules/code-editor/markdown/mermaidViewport';
import { MAX_DIAGRAM_SCALE, MIN_DIAGRAM_SCALE } from '@/shared/constants';

test('fits an oversized diagram in a narrow mobile viewport without stretching its ratio', () => {
  const size = { width: 1600, height: 900 };
  const viewport = { width: 360, height: 600 };
  const result = fitDiagram(size, viewport);
  assert.equal(result.scale, 296 / 1600);
  assert.equal(result.x, 32);
  assert.equal(result.y, (600 - 900 * result.scale) / 2);
});

test('fit keeps a small diagram at its natural size, and reset centers at exactly 100%', () => {
  assert.deepEqual(fitDiagram({ width: 100, height: 80 }, { width: 800, height: 600 }), { scale: 1, x: 350, y: 260 });
  assert.deepEqual(centerDiagram({ width: 1600, height: 900 }, { width: 400, height: 500 }, 1), { scale: 1, x: -600, y: -200 });
});

test('zoom retains the SVG point under the mouse after panning', () => {
  const current = { x: -80, y: 60, scale: 0.5 };
  const anchor = { x: 120, y: 100 };
  const result = zoomDiagramAt(current, 2, anchor);
  assert.equal((anchor.x - current.x) / current.scale, (anchor.x - result.x) / result.scale);
  assert.equal((anchor.y - current.y) / current.scale, (anchor.y - result.y) / result.scale);
});

test('repeated scrolling cannot produce zero or excessive scale', () => {
  const current = { x: 0, y: 0, scale: 1 };
  assert.equal(zoomDiagramAt(current, 0, { x: 10, y: 20 }).scale, MIN_DIAGRAM_SCALE);
  assert.equal(zoomDiagramAt(current, 1000, { x: 10, y: 20 }).scale, MAX_DIAGRAM_SCALE);
});

test('two-finger pinch can zoom and pan simultaneously around the midpoint', () => {
  const current = { x: 0, y: 0, scale: 1 };
  const result = pinchDiagram(current, [{ x: 0, y: 50 }, { x: 100, y: 50 }], [{ x: 10, y: 70 }, { x: 210, y: 70 }]);
  assert.deepEqual(result, { x: 10, y: -30, scale: 2 });
});

test('coincident pinch contacts stay finite and can translate', () => {
  const result = pinchDiagram({ x: 2, y: 3, scale: 1 }, [{ x: 10, y: 10 }, { x: 10, y: 10 }], [{ x: 12, y: 15 }, { x: 12, y: 15 }]);
  assert.deepEqual(result, { x: 4, y: 8, scale: 1 });
});
