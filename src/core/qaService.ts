import { ExplainerRunError } from '../harnesses/errors';
import type { Explainer, RunProgress, RunResult } from '../harnesses/types';
import type { ExplanationStore } from './explanationStore';
import { buildQaFallbackPrompt, buildQaPrompt } from './prompts';
import type { QaTurn } from './types';

export function parseSectionPrefix(text: string): { section?: string; question: string } {
  const m = text.match(/^About "([^"]+)":\s*([\s\S]*)$/);
  return m ? { section: m[1], question: m[2].trim() } : { question: text.trim() };
}

export interface AskResult {
  turn: QaTurn;
  usedFallback: boolean;
}

export class QAService {
  constructor(
    private readonly d: {
      runner: Pick<Explainer, 'run'>;
      store: ExplanationStore;
      cwd: string;
      timeoutMs: () => number;
      model: () => string | undefined;
      now?: () => Date;
    },
  ) {}

  async ask(
    sha: string,
    text: string,
    o: { brief: string | null; signal?: AbortSignal; onProgress?: (p: RunProgress) => void },
  ): Promise<AskResult> {
    const stored = await this.d.store.get(sha);
    if (!stored) throw new Error(`No explanation cached for ${sha}`);
    const { section, question } = parseSectionPrefix(text);
    const files = new Set<string>();
    const onProgress = (p: RunProgress) => {
      if (p.type === 'tool' && p.detail) files.add(p.detail);
      o.onProgress?.(p);
    };
    const common = { cwd: this.d.cwd, timeoutMs: this.d.timeoutMs(), model: this.d.model(), signal: o.signal, onProgress };
    const fresh = () =>
      this.d.runner.run({
        ...common,
        prompt: buildQaFallbackPrompt({ brief: o.brief, explanation: stored.explanation, thread: stored.thread, question, section }),
      });

    let result: RunResult;
    let usedFallback = false;
    if (!stored.explainerSessionId) {
      result = await fresh();
    } else {
      try {
        result = await this.d.runner.run({ ...common, prompt: buildQaPrompt(question, section), resumeSessionId: stored.explainerSessionId });
      } catch (e) {
        if (!(e instanceof ExplainerRunError)) throw e;
        usedFallback = true;
        result = await fresh();
      }
    }

    const turn: QaTurn = {
      question,
      ...(section ? { section } : {}),
      answer: result.text.trim(),
      askedAt: (this.d.now?.() ?? new Date()).toISOString(),
      filesChecked: [...files],
    };
    await this.d.store.update(sha, (s) => {
      s.thread.push(turn);
      if (result.sessionId) s.explainerSessionId = result.sessionId;
    });
    return { turn, usedFallback };
  }

  async clear(sha: string): Promise<void> {
    await this.d.store.update(sha, (s) => {
      s.thread = [];
      s.explainerSessionId = '';
    });
  }
}
