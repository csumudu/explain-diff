// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { openDiagramViewer } from '../../src/webview/diagramViewer';

function figure(): HTMLElement {
  document.body.innerHTML = `<figure class="diagram"><button class="maximize" data-action="maximizeDiagram">⤢</button>
<div class="mermaid-out"><svg viewBox="0 0 400 200" style="max-width: 400px"><g><text>hi</text></g></svg></div>
<figcaption>How it works after this commit</figcaption></figure>`;
  return document.querySelector<HTMLElement>('figure.diagram')!;
}

const viewer = () => document.querySelector<HTMLElement>('.diagram-viewer');
const zoomText = () => viewer()!.querySelector('.dv-zoom')!.textContent;
const click = (dv: string) => viewer()!.querySelector<HTMLButtonElement>(`[data-dv="${dv}"]`)!.click();
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('openDiagramViewer', () => {
  beforeEach(() => {
    document.body.className = '';
  });

  it('opens a titled full-panel dialog with a copy of the diagram', () => {
    openDiagramViewer(figure());
    const v = viewer()!;
    expect(v.getAttribute('role')).toBe('dialog');
    expect(v.querySelector('.dv-title')!.textContent).toBe('How it works after this commit');
    expect(v.querySelector('.dv-canvas svg')!.getAttribute('width')).toBe('400');
    expect(document.body.classList.contains('dv-open')).toBe(true);
    expect(document.querySelectorAll('svg')).toHaveLength(2); // original stays in place
  });

  it('zooms in and out with the buttons and resets', () => {
    openDiagramViewer(figure());
    const start = zoomText();
    click('in');
    const zoomedIn = zoomText();
    expect(zoomedIn).not.toBe(start);
    click('out');
    expect(zoomText()).toBe(start);
    click('in');
    click('reset');
    expect(zoomText()).toBe(start);
  });

  it('supports + / - / 0 keys and closes on Escape', () => {
    openDiagramViewer(figure());
    const start = zoomText();
    key('+');
    expect(zoomText()).not.toBe(start);
    key('0');
    expect(zoomText()).toBe(start);
    key('Escape');
    expect(viewer()).toBeNull();
    expect(document.body.classList.contains('dv-open')).toBe(false);
  });

  it('closes with the close button and only ever shows one viewer', () => {
    const fig = figure();
    openDiagramViewer(fig);
    openDiagramViewer(fig);
    expect(document.querySelectorAll('.diagram-viewer')).toHaveLength(1);
    click('close');
    expect(viewer()).toBeNull();
  });

  it('does nothing for a diagram that has not rendered', () => {
    document.body.innerHTML = '<figure class="diagram"><div class="mermaid-out"></div></figure>';
    openDiagramViewer(document.querySelector<HTMLElement>('figure')!);
    expect(viewer()).toBeNull();
  });

  it('starting a drag does not select diagram text', () => {
    openDiagramViewer(figure());
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1 });
    viewer()!.querySelector('.dv-stage')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
