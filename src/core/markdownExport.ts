import type { StoredExplanation } from './types';

export interface ExportMeta {
  shortSha: string;
  subject: string;
  branch?: string;
  date: string;
  sessionTitle?: string;
}

const fence = (code: string) => ['```mermaid', code, '```'].join('\n');

export function toMarkdown(s: StoredExplanation, meta: ExportMeta): string {
  const e = s.explanation;
  const out: string[] = [];
  out.push(`# ${meta.subject} (${meta.shortSha})`, '');
  out.push(
    [
      `Commit: ${meta.shortSha}`,
      meta.branch ? `Branch: ${meta.branch}` : '',
      `Date: ${meta.date}`,
      meta.sessionTitle ? `Session: ${meta.sessionTitle}` : 'Session: none found (reasoning inferred)',
      `Generated: ${s.generatedAt}`,
    ].filter(Boolean).join(' · '),
    '',
  );

  out.push('## 1. In one breath', '', e.summary, '');

  out.push('## 2. Why we did this', '');
  if (e.why.inferred) out.push('_Inferred from the commit message and code; no session transcript was found._', '');
  for (const q of e.why.userQuotes) out.push(`> ${q.text}${q.time ? ` (${q.time})` : ''}`, '');
  out.push(e.why.narrative, '');
  for (const d of e.why.decisions) out.push(`- **${d.kind === 'chosen' ? 'Chosen' : 'Rejected'}:** ${d.choice} — ${d.reason}`);
  out.push('');
  if (e.why.timelineMermaid && !e.why.inferred) out.push(fence(e.why.timelineMermaid), '');

  out.push('## 3. What changed', '');
  e.changes.forEach((c, i) => {
    out.push(`### ${String.fromCharCode(65 + i)}. ${c.title}`, '', `- **Before:** ${c.before}`, `- **After:** ${c.after}`);
    for (const f of c.files) out.push(`- \`${f.path}${f.line ? `:${f.line}` : ''}\` +${f.added} −${f.removed}`);
    out.push('');
  });

  out.push('## 4. How it works now', '', e.howItWorks.narrative, '', fence(e.howItWorks.diagramMermaid), '');

  out.push('## 5. Ripple map: who uses this', '', fence(e.ripple.diagramMermaid), '');
  for (const v of e.ripple.verified) out.push(`- \`${v.path}:${v.line}\` — ${v.role}. ${v.impact}`);
  for (const p of e.ripple.possiblyRelated) out.push(`- _Possibly related:_ \`${p.path}\` — ${p.reason}`);
  out.push('');

  out.push('## 6. What to expect', '', ...e.expectations.effects.map((x) => `- ${x}`), '', '**How to check it yourself**', '');
  out.push(...e.expectations.howToVerify.map((x) => `- ${x}`), '');

  out.push('## 7. Watch-outs', '', ...e.watchOuts.map((w) => `- **${w.kind.toUpperCase()}:** ${w.text}`), '');

  out.push('## 8. Glossary', '', ...e.glossary.map((g) => `- **${g.term}:** ${g.meaning}`), '');

  if (s.thread.length) {
    out.push('## Conversation', '');
    for (const t of s.thread) {
      out.push(`**Q${t.section ? ` (about "${t.section}")` : ''}:** ${t.question}`, '', t.answer, '');
    }
  }
  return out.join('\n');
}
