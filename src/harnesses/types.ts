import type { Session } from '../core/types';

export type RunProgress = { type: 'tool'; name: string; detail: string } | { type: 'text'; text: string };

export interface RunOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  timeoutMs: number;
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface RunResult {
  text: string;
  sessionId: string;
}

export interface SourceOptions {
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

export interface ExplainerOptions {
  /** Reads `explainDiff.<key>`. */
  settings: (key: string) => unknown;
}

/** Where agent sessions come from. One per harness. */
export interface SessionSource {
  /** Stable kebab-case id, e.g. 'claude-code'. */
  id: string;
  /** Human name, e.g. 'Claude Code'. */
  displayName: string;
  /** Session log files recorded for any of these folders. Must resolve to [] when nothing is found. */
  findSessionFiles(workspacePaths: string[], platform?: NodeJS.Platform): Promise<string[]>;
  /** Parses one log into the generic Session model. Must skip malformed lines instead of throwing. */
  parseSession(file: string): Promise<Session>;
  /** Trailer this harness adds to the commits it makes, if any. */
  commitTrailer?: RegExp;
}

/** Writes explanations and chat answers. Must keep the model read-only. */
export interface Explainer {
  id: string;
  displayName: string;
  run(o: RunOptions): Promise<RunResult>;
  version(): Promise<string | null>;
  /** Shown when the tool is missing. */
  setup: { message: string; docsUrl: string; settingId: string };
}
