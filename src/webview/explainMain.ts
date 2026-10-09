import type { ExplainToHost, HostToWebview } from '../shared/messages';
import { renderDiagrams } from './diagrams';
import { openDiagramViewer } from './diagramViewer';

declare function acquireVsCodeApi(): { postMessage(m: ExplainToHost): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

root.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  if (d.action === 'maximizeDiagram') {
    const fig = el.closest<HTMLElement>('figure.diagram');
    if (fig) openDiagramViewer(fig);
    return;
  }
  vscode.postMessage({
    type: d.action,
    path: d.path,
    line: d.line ? Number(d.line) : undefined,
    key: d.key,
    section: d.section,
  } as ExplainToHost);
});

window.addEventListener('message', async (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  if (m.type !== 'render') return;
  const y = window.scrollY;
  root.innerHTML = m.html;
  window.scrollTo(0, y);
  await renderDiagrams(root, (key, code, error) => vscode.postMessage({ type: 'diagramError', key, code, error }));
});

vscode.postMessage({ type: 'ready' });
