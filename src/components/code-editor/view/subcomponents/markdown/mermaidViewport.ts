export type DiagramSize = { width: number; height: number };
export type DiagramPoint = { x: number; y: number };
export type DiagramTransform = DiagramPoint & { scale: number };

export const MIN_DIAGRAM_SCALE = 0.02;
export const MAX_DIAGRAM_SCALE = 8;

export function clampDiagramScale(scale: number): number {
  return Math.max(MIN_DIAGRAM_SCALE, Math.min(MAX_DIAGRAM_SCALE, scale));
}

/** SVG viewBox dimensions are stable even when inline CSS shrinks the preview. */
export function diagramSizeFromSvg(svg: SVGSVGElement): DiagramSize {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    return { width: box.width, height: box.height };
  }
  const bounds = svg.getBoundingClientRect();
  return { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
}

export function centerDiagram(size: DiagramSize, viewport: DiagramSize, scale: number): DiagramTransform {
  const boundedScale = clampDiagramScale(scale);
  return {
    scale: boundedScale,
    x: (viewport.width - size.width * boundedScale) / 2,
    y: (viewport.height - size.height * boundedScale) / 2,
  };
}

export function fitDiagram(size: DiagramSize, viewport: DiagramSize): DiagramTransform {
  const padding = Math.min(32, viewport.width / 8, viewport.height / 8);
  const scale = Math.min(1, (viewport.width - padding * 2) / size.width, (viewport.height - padding * 2) / size.height);
  return centerDiagram(size, viewport, scale);
}

/** Keep the SVG point under the cursor/fingers fixed while zooming. */
export function zoomDiagramAt(transform: DiagramTransform, scale: number, anchor: DiagramPoint): DiagramTransform {
  const nextScale = clampDiagramScale(scale);
  const ratio = nextScale / transform.scale;
  return {
    scale: nextScale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}

export function pinchDiagram(
  transform: DiagramTransform,
  previous: [DiagramPoint, DiagramPoint],
  current: [DiagramPoint, DiagramPoint],
): DiagramTransform {
  const midpoint = ([first, second]: [DiagramPoint, DiagramPoint]) => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
  const distance = ([first, second]: [DiagramPoint, DiagramPoint]) => Math.hypot(second.x - first.x, second.y - first.y);
  const before = midpoint(previous);
  const after = midpoint(current);
  const previousDistance = distance(previous);
  const zoomed = zoomDiagramAt(transform, transform.scale * (previousDistance > 0 ? distance(current) / previousDistance : 1), before);
  return { ...zoomed, x: zoomed.x + after.x - before.x, y: zoomed.y + after.y - before.y };
}
