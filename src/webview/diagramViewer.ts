import { ZOOM_STEP, fitView, pan, percent, zoomAt, zoomCentered, type Size, type View } from './zoom';

let closeOpenViewer: (() => void) | undefined;

/** Opens the rendered diagram inside `fig` in a full-panel overlay with zoom, pan and reset. */
export function openDiagramViewer(fig: HTMLElement): void {
  const source = fig.querySelector<SVGSVGElement>('.mermaid-out svg');
  if (!source) return;
  closeOpenViewer?.();
  const previousFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  overlay.className = 'diagram-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `<div class="dv-toolbar">
<span class="dv-title"></span>
<button data-dv="out" aria-label="Zoom out" title="Zoom out (-)">−</button>
<span class="dv-zoom" aria-live="polite"></span>
<button data-dv="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
<button data-dv="reset" title="Fit to screen (0)">Reset</button>
<button data-dv="close" aria-label="Close" title="Close (Esc)">✕</button>
</div><div class="dv-stage"><div class="dv-canvas"></div></div>`;
  const title = fig.querySelector('figcaption')?.textContent?.trim() || 'Diagram';
  overlay.setAttribute('aria-label', title);
  overlay.querySelector('.dv-title')!.textContent = title;
  const stage = overlay.querySelector<HTMLElement>('.dv-stage')!;
  const canvas = overlay.querySelector<HTMLElement>('.dv-canvas')!;
  const zoomLabel = overlay.querySelector<HTMLElement>('.dv-zoom')!;

  const vb = source.viewBox?.baseVal;
  const rect = source.getBoundingClientRect();
  const size: Size = vb && vb.width > 0 ? { w: vb.width, h: vb.height } : { w: rect.width, h: rect.height };
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.removeAttribute('style');
  svg.setAttribute('width', String(size.w));
  svg.setAttribute('height', String(size.h));
  canvas.appendChild(svg);

  document.body.appendChild(overlay);
  document.body.classList.add('dv-open');

  const viewport = (): Size => ({ w: stage.clientWidth, h: stage.clientHeight });
  let view: View = fitView(size, viewport());
  const apply = () => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    zoomLabel.textContent = percent(view);
  };
  const reset = () => {
    view = fitView(size, viewport());
    apply();
  };
  const zoomBy = (factor: number) => {
    view = zoomCentered(view, factor, viewport());
    apply();
  };

  overlay.querySelector('.dv-toolbar')!.addEventListener('click', (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-dv]')?.dataset.dv;
    if (action === 'in') zoomBy(ZOOM_STEP);
    else if (action === 'out') zoomBy(1 / ZOOM_STEP);
    else if (action === 'reset') reset();
    else if (action === 'close') close();
  });

  stage.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        const r = stage.getBoundingClientRect();
        view = zoomAt(view, ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ev.clientX - r.left, ev.clientY - r.top);
      } else {
        view = pan(view, -ev.deltaX, -ev.deltaY);
      }
      apply();
    },
    { passive: false },
  );

  let last: { x: number; y: number } | undefined;
  stage.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); // dragging pans; it must not select the diagram's text
    last = { x: ev.clientX, y: ev.clientY };
    stage.setPointerCapture(ev.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!last) return;
    view = pan(view, ev.clientX - last.x, ev.clientY - last.y);
    last = { x: ev.clientX, y: ev.clientY };
    apply();
  });
  const endDrag = () => {
    last = undefined;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', reset);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
    if (ev.key === 'Escape') close();
    else if (ev.key === '+' || ev.key === '=') zoomBy(ZOOM_STEP);
    else if (ev.key === '-' || ev.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (ev.key === '0') reset();
    else return;
    ev.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', reset);

  function close() {
    overlay.remove();
    document.body.classList.remove('dv-open');
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', reset);
    closeOpenViewer = undefined;
    previousFocus?.focus();
  }
  closeOpenViewer = close;

  apply();
  overlay.querySelector<HTMLButtonElement>('[data-dv="close"]')!.focus();
}
