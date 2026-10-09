/** Zoom/pan state for the maximized diagram: screen = (x, y) + content * scale. */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.25;

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function fitView(content: Size, viewport: Size, padding = 24): View {
  const scale = content.w > 0 && content.h > 0
    ? clamp(Math.min((viewport.w - 2 * padding) / content.w, (viewport.h - 2 * padding) / content.h))
    : 1;
  return { scale, x: (viewport.w - content.w * scale) / 2, y: (viewport.h - content.h * scale) / 2 };
}

/** Zooms by `factor`, keeping the content point under screen position (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clamp(v.scale * factor);
  const ratio = scale / v.scale;
  return { scale, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
}

export function zoomCentered(v: View, factor: number, viewport: Size): View {
  return zoomAt(v, factor, viewport.w / 2, viewport.h / 2);
}

export function pan(v: View, dx: number, dy: number): View {
  return { scale: v.scale, x: v.x + dx, y: v.y + dy };
}

export function percent(v: View): string {
  return `${Math.round(v.scale * 100)}%`;
}
