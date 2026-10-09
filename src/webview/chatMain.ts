import type { ChatToHost, HostToWebview } from '../shared/messages';
import { renderDiagrams } from './diagrams';
import { openDiagramViewer } from './diagramViewer';

declare function acquireVsCodeApi(): { postMessage(m: ChatToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const header = document.getElementById('header')!;
const thread = document.getElementById('thread')!;
const input = document.getElementById('q') as HTMLTextAreaElement;
const send = document.getElementById('send') as HTMLButtonElement;
let busy = false;

const submit = () => {
  if (busy) {
    vscode.postMessage({ type: 'stop' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', text });
  input.value = '';
};

send.addEventListener('click', submit);
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    submit();
  }
});

document.body.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  if (d.action === 'maximizeDiagram') {
    const fig = el.closest<HTMLElement>('figure.diagram');
    if (fig) openDiagramViewer(fig);
  } else if (d.action === 'suggest') vscode.postMessage({ type: 'suggest', text: d.text ?? '' });
  else if (d.action === 'newConversation') vscode.postMessage({ type: 'newConversation' });
  else if (d.action === 'openRef') vscode.postMessage({ type: 'openRef', path: d.path ?? '', line: d.line ? Number(d.line) : undefined });
});

window.addEventListener('message', async (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  if (m.type === 'header') header.innerHTML = m.html;
  else if (m.type === 'thread') {
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    thread.innerHTML = m.html;
    await renderDiagrams(thread, () => {});
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  } else if (m.type === 'busy') {
    busy = m.busy;
    send.textContent = busy ? 'Stop' : 'Send';
  } else if (m.type === 'prefill') {
    input.value = m.text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

vscode.postMessage({ type: 'ready' });
