import { createClaudeCodeExplainer } from './claude-code/explainer';
import { createClaudeCodeSource } from './claude-code/source';
import type { Explainer, ExplainerOptions, SessionSource, SourceOptions } from './types';

/** Add a new harness's session source here (key = its id). */
export const SESSION_SOURCES: Record<string, (o: SourceOptions) => SessionSource> = {
  'claude-code': createClaudeCodeSource,
};

/** Add a new explainer here (key = its id). */
export const EXPLAINERS: Record<string, (o: ExplainerOptions) => Explainer> = {
  'claude-code': createClaudeCodeExplainer,
};

export const DEFAULT_SOURCE_IDS = ['claude-code'];
export const DEFAULT_EXPLAINER_ID = 'claude-code';

export function createSources(ids: unknown, o: SourceOptions): SessionSource[] {
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : DEFAULT_SOURCE_IDS;
  return [...new Set(list)].filter((id) => id in SESSION_SOURCES).map((id) => SESSION_SOURCES[id](o));
}

export function createExplainer(id: unknown, o: ExplainerOptions): Explainer {
  const key = typeof id === 'string' && id in EXPLAINERS ? id : DEFAULT_EXPLAINER_ID;
  return EXPLAINERS[key](o);
}
