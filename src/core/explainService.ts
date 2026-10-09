import type { Explainer, RunProgress } from '../harnesses/types';
import { PROMPT_VERSION, extractMermaid, parseExplanation, setDiagram, type DiagramKey } from './explanationSchema';
import type { ExplanationStore } from './explanationStore';
import type { GitService } from './gitService';
import { DIFF_CHAR_LIMIT, buildDiagramRepairPrompt, buildExplainPrompt, buildJsonRepairPrompt, truncateDiff } from './prompts';
import type { StoredExplanation } from './types';

export interface ExplainTarget {
  sha: string;
  brief: string | null;
}

export interface ExplainDeps {
  git: Pick<GitService, 'showStat' | 'diff'>;
  runner: Pick<Explainer, 'run'>;
  store: ExplanationStore;
  cwd: string;
  timeoutMs: () => number;
  model: () => string | undefined;
  now?: () => Date;
}

export class ExplanationInvalidError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

export class ExplainService {
  private readonly inFlight = new Map<string, Promise<StoredExplanation>>();

  constructor(private readonly d: ExplainDeps) {}

  /** A second request for a commit that is already being explained joins the running request. */
  explain(
    t: ExplainTarget,
    o: { force?: boolean; signal?: AbortSignal; onProgress?: (p: RunProgress) => void } = {},
  ): Promise<StoredExplanation> {
    const running = this.inFlight.get(t.sha);
    if (running) return running;
    const p = this.generate(t, o).finally(() => this.inFlight.delete(t.sha));
    this.inFlight.set(t.sha, p);
    return p;
  }

  private async generate(
    t: ExplainTarget,
    o: { force?: boolean; signal?: AbortSignal; onProgress?: (p: RunProgress) => void },
  ): Promise<StoredExplanation> {
    if (!o.force) {
      const cached = await this.d.store.get(t.sha);
      if (cached) return cached;
    }
    const [stat, diff] = await Promise.all([this.d.git.showStat(t.sha), this.d.git.diff(t.sha)]);
    const common = { cwd: this.d.cwd, timeoutMs: this.d.timeoutMs(), model: this.d.model(), signal: o.signal, onProgress: o.onProgress };
    const prompt = buildExplainPrompt({ sha: t.sha, brief: t.brief, stat, diff: truncateDiff(diff, DIFF_CHAR_LIMIT) });

    const first = await this.d.runner.run({ ...common, prompt });
    let parsed = parseExplanation(first.text);
    let sessionId = first.sessionId;
    if (!parsed.ok) {
      const second = await this.d.runner.run({ ...common, prompt: buildJsonRepairPrompt(parsed.error), resumeSessionId: first.sessionId });
      parsed = parseExplanation(second.text);
      sessionId = second.sessionId || sessionId;
      if (!parsed.ok) throw new ExplanationInvalidError(`Claude's answer was not a valid explanation: ${parsed.error}`, second.text);
    }

    const explanation = parsed.value;
    if (t.brief === null) explanation.why.inferred = true;
    const generatedAt = (this.d.now?.() ?? new Date()).toISOString();
    // Regenerating keeps the chat history; the next question then starts a fresh Claude
    // session that is given the new explanation plus that history.
    return this.d.store.upsert(t.sha, (prev): StoredExplanation => {
      const keepThread = !!prev?.thread.length;
      return {
        sha: t.sha,
        promptVersion: PROMPT_VERSION,
        generatedAt,
        explainerSessionId: keepThread ? '' : sessionId,
        inferred: t.brief === null,
        explanation,
        thread: keepThread ? prev!.thread : [],
      };
    });
  }

  async repairDiagram(sha: string, key: DiagramKey, code: string, error: string, signal?: AbortSignal): Promise<string> {
    const stored = await this.d.store.get(sha);
    if (!stored) throw new Error(`No explanation cached for ${sha}`);
    const r = await this.d.runner.run({
      cwd: this.d.cwd, prompt: buildDiagramRepairPrompt(code, error), timeoutMs: this.d.timeoutMs(),
      model: this.d.model(), signal, maxTurns: 1,
    });
    const fixed = extractMermaid(r.text);
    await this.d.store.update(sha, (s) => setDiagram(s.explanation, key, fixed));
    return fixed;
  }
}
