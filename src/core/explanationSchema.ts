import { z } from 'zod';

export const PROMPT_VERSION = 1;

const FileRef = z.object({ path: z.string(), line: z.number().int().optional(), added: z.number().int(), removed: z.number().int() });

export const ExplanationSchema = z.object({
  summary: z.string(),
  why: z.object({
    inferred: z.boolean(),
    userQuotes: z.array(z.object({ text: z.string(), time: z.string().optional() })),
    narrative: z.string(),
    decisions: z.array(z.object({ choice: z.string(), kind: z.enum(['chosen', 'rejected']), reason: z.string() })),
    timelineMermaid: z.string().optional(),
  }),
  changes: z.array(z.object({ title: z.string(), before: z.string(), after: z.string(), files: z.array(FileRef) })),
  howItWorks: z.object({ narrative: z.string(), diagramMermaid: z.string() }),
  ripple: z.object({
    diagramMermaid: z.string(),
    verified: z.array(z.object({ path: z.string(), line: z.number().int(), role: z.string(), impact: z.string() })),
    possiblyRelated: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  expectations: z.object({ effects: z.array(z.string()), howToVerify: z.array(z.string()) }),
  watchOuts: z.array(z.object({ kind: z.enum(['migration', 'risk', 'not-done', 'edge-case', 'follow-up']), text: z.string() })),
  glossary: z.array(z.object({ term: z.string(), meaning: z.string() })),
});

export type Explanation = z.infer<typeof ExplanationSchema>;
export type DiagramKey = 'why.timelineMermaid' | 'howItWorks.diagramMermaid' | 'ripple.diagramMermaid';
export const DIAGRAM_KEYS: DiagramKey[] = ['why.timelineMermaid', 'howItWorks.diagramMermaid', 'ripple.diagramMermaid'];

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in the reply');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseExplanation(text: string): { ok: true; value: Explanation } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const r = ExplanationSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

export function extractMermaid(text: string): string {
  const fenced = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

export function getDiagram(e: Explanation, key: DiagramKey): string | undefined {
  if (key === 'why.timelineMermaid') return e.why.timelineMermaid;
  if (key === 'howItWorks.diagramMermaid') return e.howItWorks.diagramMermaid;
  return e.ripple.diagramMermaid;
}

export function setDiagram(e: Explanation, key: DiagramKey, code: string): void {
  if (key === 'why.timelineMermaid') e.why.timelineMermaid = code;
  else if (key === 'howItWorks.diagramMermaid') e.howItWorks.diagramMermaid = code;
  else e.ripple.diagramMermaid = code;
}
