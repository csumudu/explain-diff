import { describe, it, expect } from 'vitest';
import { DEFAULT_EXPLAINER_ID, DEFAULT_SOURCE_IDS, EXPLAINERS, SESSION_SOURCES, createExplainer, createSources } from '../../src/harnesses/registry';

const sourceOpts = { homeDir: '/home/x', env: {} };
const explainerOpts = { settings: () => undefined };

describe('registry', () => {
  it('registers the defaults under their own ids', () => {
    for (const id of DEFAULT_SOURCE_IDS) expect(SESSION_SOURCES[id](sourceOpts).id).toBe(id);
    expect(EXPLAINERS[DEFAULT_EXPLAINER_ID](explainerOpts).id).toBe(DEFAULT_EXPLAINER_ID);
  });

  it('createSources skips unknown ids and duplicates, and falls back to defaults for bad input', () => {
    expect(createSources(['claude-code', 'no-such-agent', 'claude-code'], sourceOpts).map((s) => s.id)).toEqual(['claude-code']);
    expect(createSources('not-an-array', sourceOpts).map((s) => s.id)).toEqual(DEFAULT_SOURCE_IDS);
    expect(createSources([], sourceOpts)).toEqual([]);
  });

  it('createExplainer falls back to the default for unknown ids', () => {
    expect(createExplainer('no-such-explainer', explainerOpts).id).toBe(DEFAULT_EXPLAINER_ID);
    expect(createExplainer(undefined, explainerOpts).id).toBe(DEFAULT_EXPLAINER_ID);
  });
});
