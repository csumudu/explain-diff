import { eventIndexAt } from './commitLinker';
import type { Session, SessionEvent } from './types';

export interface BriefInput {
  session: Session;
  eventIndex: number | null;
  commitTime: string;
  laterCommits: { shortSha: string; subject: string }[];
  budgetTokens: number;
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function buildBrief(input: BriefInput): string {
  const { session, laterCommits, budgetTokens } = input;
  const events = session.events;
  const idx = input.eventIndex ?? eventIndexAt(session, input.commitTime) ?? events.length - 1;

  let windowStart = 0;
  for (let i = Math.min(idx, events.length - 1); i >= 0; i--) {
    if (events[i].kind === 'user') {
      windowStart = i;
      break;
    }
  }

  const prompts: { time: string; text: string }[] = [];
  const prose: { time: string; text: string }[] = [];
  events.slice(0, windowStart).forEach((e) => {
    if (e.kind === 'user') prompts.push({ time: e.time, text: e.text });
    if (e.kind === 'assistant') prose.push({ time: e.time, text: e.text });
  });
  const windowLines = events.slice(windowStart, idx + 1).map(formatWindowEvent);
  const edited = new Set<string>();
  events.slice(0, idx + 1).forEach((e) => {
    if (e.kind === 'toolCall' && e.editedFile) edited.add(e.editedFile);
  });

  const render = () =>
    [
      '# Session',
      `Title: ${session.title}`,
      `Branch: ${session.branch ?? 'unknown'}`,
      `Started: ${session.start}`,
      '',
      '## What the user asked (in order)',
      ...prompts.map((p) => `- [${p.time}] ${p.text}`),
      '',
      '## What the agent said (before the commit window)',
      ...prose.map((p) => `- [${p.time}] ${p.text}`),
      '',
      '## Around the commit (full detail)',
      ...windowLines,
      '',
      '## Files edited before this commit',
      ...(edited.size ? [...edited].map((f) => `- ${f}`) : ['- none recorded']),
      '',
      '## Later commits in this session',
      ...(laterCommits.length ? laterCommits.map((c) => `- ${c.shortSha} ${c.subject}`) : ['- none']),
    ].join('\n');

  let brief = render();
  if (estimateTokens(brief) <= budgetTokens) return brief;

  for (const p of prose) p.text = firstAndLast(p.text);
  brief = render();
  if (estimateTokens(brief) <= budgetTokens) return brief;

  for (const p of prompts) p.text = p.text.slice(0, 300);
  brief = render();

  while (estimateTokens(brief) > budgetTokens && prose.length) {
    prose.shift();
    brief = render();
  }
  while (estimateTokens(brief) > budgetTokens && prompts.length) {
    prompts.shift();
    brief = render();
  }
  return brief;
}

function formatWindowEvent(e: SessionEvent): string {
  switch (e.kind) {
    case 'user':
      return `[${e.time}] USER: ${e.text}`;
    case 'assistant':
      return `[${e.time}] CLAUDE: ${e.text}`;
    case 'toolCall':
      return `[${e.time}] TOOL ${e.name}: ${JSON.stringify(e.input).slice(0, 500)}`;
    case 'toolResult':
      return `[${e.time}] RESULT: ${e.text.slice(0, 1000)}`;
  }
}

function firstAndLast(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 2) return text;
  return `${sentences[0]} … ${sentences[sentences.length - 1]}`;
}
