import type { Explanation } from './explanationSchema';
import type { QaTurn } from './types';

export const DIFF_CHAR_LIMIT = 40000;

const SCHEMA_TEXT = `type Explanation = {
  summary: string;                         // 2-3 sentences a newcomer can follow
  why: {
    inferred: boolean;                     // true when there is no session transcript
    userQuotes: { text: string; time?: string }[];   // the user's own words from the session
    narrative: string;
    decisions: { choice: string; kind: "chosen" | "rejected"; reason: string }[];
    timelineMermaid?: string;              // Mermaid "timeline" of the session up to this commit
  };
  changes: {                               // grouped by purpose, not by file
    title: string; before: string; after: string;
    files: { path: string; line?: number; added: number; removed: number }[];
  }[];
  howItWorks: { narrative: string; diagramMermaid: string };   // flowchart or sequenceDiagram
  ripple: {
    diagramMermaid: string;                // flowchart: changed code in the middle, -.-> for unverified
    verified: { path: string; line: number; role: string; impact: string }[];
    possiblyRelated: { path: string; reason: string }[];
  };
  expectations: { effects: string[]; howToVerify: string[] };
  watchOuts: { kind: "migration" | "risk" | "not-done" | "edge-case" | "follow-up"; text: string }[];
  glossary: { term: string; meaning: string }[];
};`;

const WRITING_RULES = `RULES
- Write in plain language with short sentences. The reader is smart but new to this code.
- Every technical term you use must also appear in "glossary" with a simple meaning.
- Every claim about code must cite a real location as path:line, with the path relative to the repository root.
- You must not modify any files.`;

export function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;
  const chunks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const order = chunks.map((c, i) => ({ c, i })).sort((a, b) => b.c.length - a.c.length);
  const keep = new Set<number>();
  let used = 0;
  for (const { c, i } of order) {
    if (used + c.length <= limit) {
      keep.add(i);
      used += c.length;
    }
  }
  const omitted = chunks.filter((_, i) => !keep.has(i)).map((c) => c.match(/^diff --git a\/(\S+)/)?.[1] ?? '?');
  const kept = chunks.filter((_, i) => keep.has(i)).join('');
  return `${kept}\nOmitted from this prompt (read them yourself with git show): ${omitted.join(', ')}\n`;
}

export function buildExplainPrompt(i: { sha: string; brief: string | null; stat: string; diff: string }): string {
  const intent = i.brief
    ? '- Base "why" on the session brief below. Quote the user\'s own words in why.userQuotes. Do not invent intent that is not in the brief.'
    : '- There is no session transcript for this commit. Set why.inferred to true, leave why.userQuotes empty, omit why.timelineMermaid, and base "why" only on the commit message and the code, saying clearly that it is a best guess.';
  return `You are explaining one git commit to a developer who did not watch it being made.
Give a complete "360 degree" view: what changed, why, how it works now, who else in the app uses it, what to expect, and what to watch out for.

${WRITING_RULES}
- Find who uses the changed code by actually searching the repository (Grep, Glob, Read, git grep). List a usage under ripple.verified only if you saw it in a search result or a file you read. Anything you suspect but did not confirm goes in ripple.possiblyRelated.
${intent}
- Diagrams are Mermaid source without code fences. Keep node labels short and do not put ( ) [ ] { } " or ; inside labels.

OUTPUT
Reply with ONE JSON object and nothing else, matching this TypeScript type:
${SCHEMA_TEXT}

COMMIT ${i.sha}
${i.stat}

DIFF
${i.diff}

SESSION BRIEF
${i.brief ?? '(none)'}
`;
}

export function buildJsonRepairPrompt(error: string): string {
  return `Your previous reply could not be used: ${error}
Reply again with ONE JSON object and nothing else, matching the Explanation type exactly. Keep the same content.`;
}

export function buildDiagramRepairPrompt(code: string, error: string): string {
  return `This Mermaid diagram fails to parse.
Error: ${error}

${code}

Reply with only the corrected Mermaid source, no code fences, no explanation. Keep the meaning. Keep labels short and avoid ( ) [ ] { } " ; inside labels.`;
}

export function buildQaPrompt(question: string, section?: string): string {
  const about = section ? ` The question is about the "${section}" section of your explanation.` : '';
  return `Follow-up question from the reader.${about}
Answer in plain language with short sentences. Cite code as path:line. Search or read code if you need to; you must not modify files.
You may include a Mermaid diagram in a \`\`\`mermaid block when it helps.

Question: ${question}`;
}

export function buildQaFallbackPrompt(i: {
  brief: string | null;
  explanation: Explanation;
  thread: QaTurn[];
  question: string;
  section?: string;
}): string {
  const history = i.thread.map((t) => `Reader: ${t.question}\nYou: ${t.answer}`).join('\n\n');
  return `You previously explained a git commit to a reader. Here is your explanation as JSON:
${JSON.stringify(i.explanation, null, 2)}

SESSION BRIEF
${i.brief ?? '(none)'}

CONVERSATION SO FAR
${history || '(none)'}

${buildQaPrompt(i.question, i.section)}`;
}
