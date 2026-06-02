import test from 'node:test';
import assert from 'node:assert/strict';
import { ExperienceExtractor, type ExtractionContext } from './ExperienceExtractor.js';
import { ContextBus } from './ContextBus.js';

test('ExperienceExtractor: should extract review-rejection as bug-pattern', () => {
  const extractor = new ExperienceExtractor();
  const bus = new ContextBus();
  const ctx: ExtractionContext = {
    planId: 'p1',
    sessionId: 's1',
    tasks: [
      { id: 't1', title: 'Implement login', agentType: 'code-agent', status: 'failed', outputSummary: '', outputFiles: [], modifiedFiles: [] },
    ],
    failedTasks: [{ taskId: 't1', agentType: 'review-agent', error: 'Missing null check in auth.ts:42', retryCount: 0 }],
    contextBus: bus,
  };
  const entries = extractor.extract(ctx);
  const bugPatterns = entries.filter(e => e.type === 'bug-pattern');
  assert.ok(bugPatterns.length > 0, 'should have at least one bug-pattern');
  assert.ok(bugPatterns[0].agentTypes.includes('code-agent'), 'should include code-agent in agentTypes');
  assert.ok(bugPatterns[0].detail.includes('auth.ts'), 'should include auth.ts in detail');
});

test('ExperienceExtractor: should extract concurrent file edit as dependency-topology', () => {
  const extractor = new ExperienceExtractor();
  const bus = new ContextBus();
  const ctx: ExtractionContext = {
    planId: 'p1',
    sessionId: 's1',
    tasks: [
      { id: 't1', title: 'Add auth hook', agentType: 'code-agent', status: 'done', outputSummary: '', outputFiles: [], modifiedFiles: ['src/auth.ts'] },
      { id: 't2', title: 'Fix auth bug', agentType: 'code-agent', status: 'done', outputSummary: '', outputFiles: [], modifiedFiles: ['src/auth.ts'] },
    ],
    failedTasks: [],
    contextBus: bus,
  };
  const entries = extractor.extract(ctx);
  const topologies = entries.filter(e => e.type === 'dependency-topology');
  assert.ok(topologies.length > 0, 'should have at least one dependency-topology');
  assert.ok(topologies[0].detail.includes('src/auth.ts'), 'should mention the conflicting file');
});

test('ExperienceExtractor: should extract conventions from ContextBus', () => {
  const extractor = new ExperienceExtractor();
  const bus = new ContextBus();
  bus.set({ key: 'c1', value: 'Use @/ imports', type: 'convention', author: 'review-agent', tags: ['code-agent'], status: 'active' });
  bus.set({ key: 'c2', value: 'Use describe/it pattern', type: 'convention', author: 'test-agent', tags: ['test-agent'], status: 'active' });

  const ctx: ExtractionContext = {
    planId: 'p1',
    sessionId: 's1',
    tasks: [],
    failedTasks: [],
    contextBus: bus,
  };
  const entries = extractor.extract(ctx);
  const conventions = entries.filter(e => e.type === 'project-convention');
  assert.equal(conventions.length, 2, 'should extract both convention entries');
});

test('ExperienceExtractor: should return empty for no failures or conventions', () => {
  const extractor = new ExperienceExtractor();
  const bus = new ContextBus();
  const ctx: ExtractionContext = {
    planId: 'p1',
    sessionId: 's1',
    tasks: [{ id: 't1', title: 'OK task', agentType: 'code-agent', status: 'done', outputSummary: '', outputFiles: [], modifiedFiles: [] }],
    failedTasks: [],
    contextBus: bus,
  };
  const entries = extractor.extract(ctx);
  assert.equal(entries.length, 0, 'should return empty array when nothing to extract');
});
