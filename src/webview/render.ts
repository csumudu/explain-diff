import type { ChangedFile, QaTurn, StoredExplanation } from '../core/types';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const REF = /(?<![\w/.@:-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):(\d+)/g;

function linkRefs(escaped: string): string {
  return escaped.replace(REF, (_m, p: string, l: string) => `<a href="#" class="ref" data-action="openRef" data-path="${p}" data-line="${l}">${p}:${l}</a>`);
}

export function rich(s: string): string {
  return linkRefs(esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'));
}

export interface HeaderInfo {
  shortSha: string;
  subject: string;
  branch?: string;
  date: string;
  added: number;
  removed: number;
  fileCount: number;
  sessionTitle?: string;
  generatedAt?: string;
  hasTranscript: boolean;
  explainerName: string;
}

export type ExplainView =
  | { kind: 'loading'; header: HeaderInfo; steps: { label: string; state: 'done' | 'active' | 'todo' }[]; log: string[] }
  | { kind: 'error'; header: HeaderInfo; variant: 'cliMissing' | 'failed'; message: string; details?: string; setup?: { message: string; docsUrl: string } }
  | { kind: 'ready'; header: HeaderInfo; stored: StoredExplanation; files: ChangedFile[]; failedDiagrams: Record<string, string> };

export const SECTION_TITLES = ['In one breath', 'Why we did this', 'What changed', 'How it works now', 'Ripple map', 'What to expect', 'Watch-outs', 'Glossary'];

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function diagram(key: string, code: string, caption: string, failedError?: string): string {
  const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : '';
  if (failedError !== undefined) {
    return `<figure class="diagram failed" data-key="${esc(key)}"><pre class="mermaid-src">${esc(code)}</pre><p class="err">${esc(failedError)}</p><button data-action="retryDiagram" data-key="${esc(key)}">Retry diagram</button>${cap}</figure>`;
  }
  return `<figure class="diagram" data-key="${esc(key)}"><button class="maximize" data-action="maximizeDiagram" aria-label="Maximize diagram" hidden>⤢</button><pre class="mermaid-src">${esc(code)}</pre><div class="mermaid-out"></div>${cap}</figure>`;
}

function section(id: string, n: number, title: string, body: string): string {
  return `<section id="${id}" class="sec"><div class="sec-head"><h2>${n} · ${esc(title)}</h2><button class="ask" data-action="askSection" data-section="${esc(title)}" aria-label="Ask about ${esc(title)} in chat">Ask</button></div>${body}</section>`;
}

function renderHeader(h: HeaderInfo, withActions: boolean): string {
  const meta = [
    `<code>${esc(h.shortSha)}</code>`,
    h.branch ? `<span>${esc(h.branch)}</span>` : '',
    `<span>${esc(fmtDate(h.date))}</span>`,
    `<span><span class="add">+${h.added}</span> <span class="del">−${h.removed}</span> in ${h.fileCount} files</span>`,
    h.sessionTitle ? `<span>Session: ${esc(h.sessionTitle)}</span>` : '<span>No session found</span>',
  ].filter(Boolean).join('<span class="dot">·</span>');
  const actions = withActions
    ? `<div class="actions">
<button class="primary" data-action="openAllChanges">Open all changes</button>
<button data-action="openChat">Chat</button>
<button data-action="regenerate">Regenerate</button>
<button data-action="export">Export Markdown</button>
${h.hasTranscript ? '<button data-action="openTranscript">Open session transcript</button>' : ''}
${h.generatedAt ? `<span class="cached">Cached · generated ${esc(fmtDate(h.generatedAt))}</span>` : ''}
</div>
<nav class="chips" aria-label="Sections">${SECTION_TITLES.map((t, i) => `<a href="#s${i + 1}">${esc(t)}</a>`).join('')}</nav>`
    : '';
  return `<header class="hdr"><div class="meta">${meta}</div><h1>${esc(h.subject)}</h1>${actions}</header>`;
}

export function renderExplainView(v: ExplainView): string {
  if (v.kind === 'loading') {
    const steps = v.steps
      .map((s) => `<li class="step ${s.state}"><span class="mark">${s.state === 'done' ? '✓' : s.state === 'active' ? '●' : '○'}</span>${esc(s.label)}</li>`)
      .join('');
    const log = v.log.slice(-8).map((l) => `<div>${esc(l)}</div>`).join('');
    return `${renderHeader(v.header, false)}<div class="state"><h2 class="state-title">Explaining ${esc(v.header.shortSha)}…</h2><ol class="steps">${steps}</ol><div class="log">${log}</div><p class="muted">Usually 30–90 seconds. The diff tabs are ready while you wait.</p><button data-action="cancel">Cancel</button></div>`;
  }
  if (v.kind === 'error') {
    if (v.variant === 'cliMissing') {
      const name = esc(v.header.explainerName);
      const docs = v.setup?.docsUrl ?? '';
      return `${renderHeader(v.header, false)}<div class="state"><h2 class="state-title">${name} is needed to write explanations</h2><p>${esc(v.setup?.message ?? '')} The commit list and diff tabs still work.</p><p>${esc(v.message)}</p>${/^https:\/\//.test(docs) ? `<a class="button primary" href="${esc(docs)}">How to install ${name}</a> ` : ''}<button data-action="openSettings">Open the setting</button></div>`;
    }
    return `${renderHeader(v.header, false)}<div class="state"><h2 class="state-title">The explanation didn't finish</h2><p>${esc(v.message)} Nothing was saved, so trying again is safe.</p>${v.details ? `<details><summary>Technical details</summary><pre>${esc(v.details)}</pre></details>` : ''}<button class="primary" data-action="retry">Try again</button> <button data-action="openAllChanges">Open all changes instead</button></div>`;
  }

  const e = v.stored.explanation;
  const fileByPath = new Map(v.files.map((f) => [f.path, f]));
  const fd = v.failedDiagrams;

  const s1 = `<p class="lead">${rich(e.summary)}</p>`;

  const quotes = e.why.userQuotes
    .map((q) => `<figure class="quote"><blockquote>“${rich(q.text)}”</blockquote><figcaption>You${q.time ? `, ${esc(q.time)}` : ''}</figcaption></figure>`)
    .join('');
  const decisions = e.why.decisions.length
    ? `<h3>Decisions made in the session</h3><div class="grid2">${e.why.decisions
        .map((d) => `<div class="card"><span class="tag ${d.kind}">${d.kind === 'chosen' ? 'CHOSEN' : 'REJECTED'}</span><div>${rich(d.choice)}</div><div class="muted">${rich(d.reason)}</div></div>`)
        .join('')}</div>`
    : '';
  const timeline =
    e.why.timelineMermaid && !e.why.inferred
      ? diagram('why.timelineMermaid', e.why.timelineMermaid, 'Timeline of the session leading up to this commit', fd['why.timelineMermaid'])
      : '';
  const s2 = `${e.why.inferred ? '<p><span class="tag inferred">INFERRED</span> <span class="muted">No session transcript was found. This is a best guess from the commit message and code.</span></p>' : ''}${quotes}<p>${rich(e.why.narrative)}</p>${decisions}${timeline}`;

  const chip = (path: string, line?: number) => {
    const f = fileByPath.get(path);
    const stats = f && !f.binary ? ` <span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>` : '';
    return `<a href="#" class="chip" data-action="focusFile" data-path="${esc(path)}"><code>${esc(path)}${line ? `:${line}` : ''}</code>${stats}</a>`;
  };
  const changes = e.changes
    .map(
      (c, i) =>
        `<div class="card"><h3>${String.fromCharCode(65 + i)}. ${rich(c.title)}</h3><div class="grid2"><div class="ba"><span class="tag">BEFORE</span><div>${rich(c.before)}</div></div><div class="ba"><span class="tag chosen">AFTER</span><div>${rich(c.after)}</div></div></div><div class="chips-row">${c.files.map((f) => chip(f.path, f.line)).join('')}</div></div>`,
    )
    .join('');
  const binary = v.files.filter((f) => f.binary);
  const binaryNote = binary.length ? `<p class="muted">Binary files (no diff tab): ${binary.map((f) => `<code>${esc(f.path)}</code> binary`).join(', ')}</p>` : '';
  const s3 = `${changes}${binaryNote}`;

  const s4 = `<p>${rich(e.howItWorks.narrative)}</p>${diagram('howItWorks.diagramMermaid', e.howItWorks.diagramMermaid, 'How it works after this commit', fd['howItWorks.diagramMermaid'])}`;

  const verified = e.ripple.verified
    .map((r) => `<li><a href="#" class="ref" data-action="openRef" data-path="${esc(r.path)}" data-line="${r.line}"><code>${esc(r.path)}:${r.line}</code></a> ${rich(r.role)}. ${rich(r.impact)}</li>`)
    .join('');
  const possibly = e.ripple.possiblyRelated
    .map((r) => `<li class="muted"><code>${esc(r.path)}</code> Possibly related: ${rich(r.reason)}</li>`)
    .join('');
  const s5 = `${diagram('ripple.diagramMermaid', e.ripple.diagramMermaid, 'Solid: verified by search · Dotted: possibly related, not verified', fd['ripple.diagramMermaid'])}<ul class="ripple">${verified}${possibly}</ul>`;

  const s6 = `<ul>${e.expectations.effects.map((x) => `<li>${rich(x)}</li>`).join('')}</ul><div class="card"><h3>How to check it yourself</h3><ul>${e.expectations.howToVerify.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></div>`;

  const s7 = `<ul class="watch">${e.watchOuts.map((w) => `<li><span class="tag ${esc(w.kind)}">${esc(w.kind.toUpperCase())}</span> ${rich(w.text)}</li>`).join('')}</ul>`;

  const s8 = `<dl class="glossary">${e.glossary.map((g) => `<div><dt>${esc(g.term)}</dt><dd>${rich(g.meaning)}</dd></div>`).join('')}</dl>`;

  const bodies = [s1, s2, s3, s4, s5, s6, s7, s8];
  const sections = SECTION_TITLES.map((t, i) => section(`s${i + 1}`, i + 1, t, bodies[i])).join('');
  return `${renderHeader(v.header, true)}${sections}<footer class="muted">Written by ${esc(v.header.explainerName)} from ${v.header.sessionTitle ? `the session “${esc(v.header.sessionTitle)}”` : 'the commit'} and the commit diff. File references link to the code they describe.</footer>`;
}

// ---------- chat ----------

export interface PendingTurn {
  question: string;
  section?: string;
  partial: string;
  files: string[];
}

export interface ChatView {
  commit?: { shortSha: string; subject: string };
  unavailable?: string;
  thread: QaTurn[];
  pending?: PendingTurn;
  notice?: string;
  error?: string;
}

const SUGGESTIONS = ['What breaks if I revert this?', "Explain it like I'm new here", 'How would I test this?'];

export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (key(d) === key(now)) return 'Today';
  if (key(d) === key(yesterday)) return `Yesterday · ${md}`;
  return md;
}

export function renderAnswer(md: string, keyPrefix: string): string {
  const out: string[] = [];
  let diagramN = 0;
  const parts = md.split(/```(\w*)\n([\s\S]*?)```/);
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i];
    for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
      const lines = para.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        out.push(`<ul>${lines.map((l) => `<li>${rich(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`);
      } else {
        out.push(`<p>${lines.map((l) => rich(l.replace(/^#+\s*/, ''))).join('<br>')}</p>`);
      }
    }
    if (i + 2 < parts.length) {
      const lang = parts[i + 1];
      const code = parts[i + 2].replace(/\n$/, '');
      out.push(lang === 'mermaid' ? diagram(`${keyPrefix}-${diagramN++}`, code, '') : `<pre><code>${esc(code)}</code></pre>`);
    }
  }
  return out.join('');
}

export function renderChatHeader(v: ChatView): string {
  if (!v.commit) return '<div class="chat-hdr"><span class="label">CHAT</span><span class="muted">Select a commit to start.</span></div>';
  return `<div class="chat-hdr"><div class="who"><span class="label">CHATTING ABOUT</span><span class="title"><code>${esc(v.commit.shortSha)}</code> ${esc(v.commit.subject)}</span><span class="muted">Knows the session, the explanation and the code (read-only)</span></div><button data-action="newConversation">New conversation</button></div>`;
}

function question(q: string, section?: string): string {
  return `<div class="msg me">${section ? `<span class="about">About “${esc(section)}”</span><br>` : ''}${esc(q)}</div>`;
}

export function renderChatThread(v: ChatView, now: Date = new Date()): string {
  if (v.unavailable) return `<p class="muted center">${esc(v.unavailable)}</p>`;
  const out: string[] = [];
  let lastDay = '';
  v.thread.forEach((t, i) => {
    const day = dayLabel(t.askedAt, now);
    if (day !== lastDay) {
      out.push(`<div class="day"><span>${esc(day)}</span></div>`);
      lastDay = day;
    }
    out.push(question(t.question, t.section));
    const files = t.filesChecked.length ? `<div class="files">Checked: ${t.filesChecked.map(esc).join(', ')}</div>` : '';
    out.push(`<div class="msg claude">${renderAnswer(t.answer, `qa-${i}`)}${files}</div>`);
  });
  if (v.pending) {
    if (lastDay !== 'Today') out.push('<div class="day"><span>Today</span></div>');
    out.push(question(v.pending.question, v.pending.section));
    const files = v.pending.files.length ? `<div class="files">Checking: ${v.pending.files.map(esc).join(', ')}</div>` : '';
    out.push(`<div class="msg claude pending">${v.pending.partial ? renderAnswer(v.pending.partial, 'qa-pending') : '<p class="muted">Thinking…</p>'}${files}</div>`);
  }
  if (v.notice) out.push(`<p class="notice">${esc(v.notice)}</p>`);
  if (v.error) out.push(`<p class="error">${esc(v.error)}</p>`);
  const suggestions = (v.thread.length ? SUGGESTIONS.slice(0, 2) : SUGGESTIONS)
    .map((s) => `<button class="suggest" data-action="suggest" data-text="${esc(s)}">${esc(s)}</button>`)
    .join('');
  if (!v.pending) out.push(`<div class="suggestions">${suggestions}</div>`);
  return out.join('');
}
