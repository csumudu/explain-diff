import * as vscode from 'vscode';
import { ExplainerAbortedError } from '../harnesses/errors';
import type { ExplanationStore } from '../core/explanationStore';
import { parseSectionPrefix, type QAService } from '../core/qaService';
import type { ChatToHost, HostToWebview } from '../shared/messages';
import { renderChatHeader, renderChatThread, type ChatView, type PendingTurn } from '../webview/render';
import type { CommitContext } from './controller';
import { webviewHtml } from './explainPanel';

const BODY = `<div id="header"></div><div id="thread" aria-live="polite"></div>
<div class="composer"><label for="q" class="visually-hidden">Message</label><textarea id="q" rows="2" placeholder="Ask about this commit…"></textarea><button id="send" class="primary">Send</button></div>`;

export class ChatPanel {
  static readonly viewType = 'explainDiff.chat';
  private panel?: vscode.WebviewPanel;
  private ctx?: CommitContext;
  private pending?: PendingTurn;
  private abort?: AbortController;
  private notice?: string;
  private error?: string;
  private pendingPrefill?: string;

  constructor(private readonly deps: { extensionUri: vscode.Uri; qa: QAService; store: ExplanationStore; openRef: (path: string, line?: number) => void }) {}

  get isOpen() {
    return !!this.panel;
  }

  show(ctx: CommitContext | undefined, o: { prefill?: string; focus?: boolean } = {}) {
    if (ctx?.linked.commit.sha !== this.ctx?.linked.commit.sha) {
      this.abort?.abort();
      this.pending = undefined;
      this.notice = undefined;
      this.error = undefined;
    }
    this.ctx = ctx;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        ChatPanel.viewType,
        'Chat',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !o.focus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist'), vscode.Uri.joinPath(this.deps.extensionUri, 'media')] },
      );
      this.panel.webview.html = webviewHtml(this.panel.webview, this.deps.extensionUri, 'chat.js', BODY);
      this.panel.webview.onDidReceiveMessage((m: ChatToHost) => void this.onMessage(m));
      this.panel.onDidDispose(() => {
        this.abort?.abort();
        this.panel = undefined;
      });
    } else if (o.focus) {
      this.panel.reveal(undefined, false);
    }
    this.panel.title = ctx ? `Chat · ${ctx.linked.commit.shortSha}` : 'Chat';
    if (o.prefill) {
      this.pendingPrefill = o.prefill;
      this.post({ type: 'prefill', text: o.prefill });
    }
    void this.refresh();
  }

  private post(m: HostToWebview) {
    void this.panel?.webview.postMessage(m);
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    const c = this.ctx?.linked.commit;
    const stored = c ? await this.deps.store.get(c.sha) : undefined;
    const view: ChatView = {
      commit: c ? { shortSha: c.shortSha, subject: c.subject } : undefined,
      unavailable: !c ? 'Select a commit to start chatting.' : !stored ? 'The explanation is still being written. You can ask once it is ready.' : undefined,
      thread: stored?.thread ?? [],
      pending: this.pending,
      notice: this.notice,
      error: this.error,
    };
    this.post({ type: 'header', html: renderChatHeader(view) });
    this.post({ type: 'thread', html: renderChatThread(view) });
    this.post({ type: 'busy', busy: !!this.pending });
  }

  private async ask(text: string) {
    const ctx = this.ctx;
    if (!ctx || this.pending || !text.trim()) return;
    const sha = ctx.linked.commit.sha;
    const { section, question } = parseSectionPrefix(text);
    this.pending = { question, section, partial: '', files: [] };
    this.notice = undefined;
    this.error = undefined;
    const abort = (this.abort = new AbortController());
    await this.refresh();
    try {
      const r = await this.deps.qa.ask(sha, text, {
        brief: ctx.brief,
        signal: abort.signal,
        onProgress: (p) => {
          if (!this.pending) return;
          if (p.type === 'tool' && p.detail) this.pending.files.push(p.detail);
          if (p.type === 'text') this.pending.partial = p.text;
          void this.refresh();
        },
      });
      if (r.usedFallback) this.notice = 'The earlier chat session had expired, so a fresh one was started with this commit’s context.';
    } catch (e) {
      if (!(e instanceof ExplainerAbortedError)) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.ctx?.linked.commit.sha === sha) this.pending = undefined;
      await this.refresh();
    }
  }

  private async onMessage(m: ChatToHost) {
    switch (m.type) {
      case 'ready':
        await this.refresh();
        if (this.pendingPrefill) this.post({ type: 'prefill', text: this.pendingPrefill });
        this.pendingPrefill = undefined;
        return;
      case 'send':
      case 'suggest':
        this.pendingPrefill = undefined;
        return this.ask(m.text);
      case 'stop':
        this.abort?.abort();
        return;
      case 'newConversation': {
        if (!this.ctx) return;
        if (this.pending) {
          vscode.window.showInformationMessage('Wait for the current answer to finish, or press Stop, before starting a new conversation.');
          return;
        }
        const ok = await vscode.window.showWarningMessage('Start a new conversation? The current chat history for this commit will be cleared.', { modal: true }, 'Clear');
        if (ok !== 'Clear') return;
        await this.deps.qa.clear(this.ctx.linked.commit.sha);
        this.notice = undefined;
        this.error = undefined;
        return this.refresh();
      }
      case 'openRef':
        return this.deps.openRef(m.path, m.line);
    }
  }
}
