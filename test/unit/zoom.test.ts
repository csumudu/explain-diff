import { describe, it, expect } from 'vitest';
import { MAX_SCALE, MIN_SCALE, fitView, pan, percent, zoomAt, zoomCentered } from '../../src/webview/zoom';

describe('fitView', () => {
  it('scales the diagram to fit inside the padded viewport and centres it', () => {
    expect(fitView({ w: 400, h: 200 }, { w: 1000, h: 600 }, 20)).toEqual({ scale: 2.4, x: 20, y: 60 });
  });
  it('never fits beyond the maximum zoom', () => {
    expect(fitView({ w: 10, h: 10 }, { w: 1000, h: 1000 }, 20)).toEqual({ scale: MAX_SCALE, x: 460, y: 460 });
  });
  it('falls back to 100% for an empty diagram', () => {
    expect(fitView({ w: 0, h: 0 }, { w: 800, h: 600 }, 20).scale).toBe(1);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    // the content point that was under the cursor (100, 50) is still at screen (100, 50)
    expect(v.x + 100 * v.scale).toBe(100);
    expect(v.y + 50 * v.scale).toBe(50);
  });
  it('clamps to the maximum and minimum zoom, still keeping the cursor point fixed', () => {
    const big = zoomAt({ scale: 7, x: 0, y: 0 }, 1.25, 70, 0);
    expect(big.scale).toBe(MAX_SCALE);
    expect(big.x + 10 * big.scale).toBeCloseTo(70);
    expect(zoomAt({ scale: 0.11, x: 0, y: 0 }, 0.5, 0, 0).scale).toBe(MIN_SCALE);
  });
  it('zoomCentered zooms around the middle of the viewport', () => {
    expect(zoomCentered({ scale: 1, x: 0, y: 0 }, 2, { w: 200, h: 100 })).toEqual({ scale: 2, x: -100, y: -50 });
  });
});

describe('pan and percent', () => {
  it('moves the view by the drag distance', () => {
    expect(pan({ scale: 2, x: 10, y: 10 }, 5, -3)).toEqual({ scale: 2, x: 15, y: 7 });
  });
  it('formats the zoom level', () => {
    expect(percent({ scale: 1.234, x: 0, y: 0 })).toBe('123%');
  });
});
