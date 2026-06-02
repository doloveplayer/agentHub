import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBus } from './ContextBus.js';

test('ContextBus: should set and get entries', () => {
  const bus = new ContextBus();
  bus.set({
    key: 'proj:convention:import-style',
    value: { alias: '@/', forbidRelative: true },
    type: 'convention',
    author: 'code-agent',
    tags: ['import', 'style'],
    status: 'active',
  });
  const entry = bus.get('proj:convention:import-style');
  assert.ok(entry);
  assert.deepEqual(entry!.value, { alias: '@/', forbidRelative: true });
  assert.equal(entry!.version, 1);
});

test('ContextBus: should overwrite and bump version', () => {
  const bus = new ContextBus();
  bus.set({ key: 'k', value: 'v1', type: 'project-fact', author: 'a', tags: [], status: 'active' });
  bus.set({ key: 'k', value: 'v2', type: 'project-fact', author: 'b', tags: [], status: 'resolved' });
  const entry = bus.get('k');
  assert.ok(entry);
  assert.equal(entry!.value, 'v2');
  assert.equal(entry!.version, 2);
  assert.equal(entry!.author, 'b');
  assert.equal(entry!.status, 'resolved');
});

test('ContextBus: should query by type and tags', () => {
  const bus = new ContextBus();
  bus.set({ key: 'a', value: 1, type: 'convention', author: 'x', tags: ['ts'], status: 'active' });
  bus.set({ key: 'b', value: 2, type: 'known-issue', author: 'y', tags: ['ts', 'null'], status: 'active' });
  bus.set({ key: 'c', value: 3, type: 'convention', author: 'z', tags: ['docker'], status: 'active' });

  const conventions = bus.query({ type: 'convention' });
  assert.equal(conventions.length, 2);

  const tsTagged = bus.query({ tags: ['ts'] });
  assert.equal(tsTagged.length, 2);

  const nullTagged = bus.query({ tags: ['null'] });
  assert.equal(nullTagged.length, 1);
});

test('ContextBus: should filter by status', () => {
  const bus = new ContextBus();
  bus.set({ key: 'a', value: 1, type: 'project-fact', author: 'x', tags: [], status: 'active' });
  bus.set({ key: 'b', value: 2, type: 'project-fact', author: 'y', tags: [], status: 'resolved' });

  const active = bus.query({ status: 'active' });
  assert.equal(active.length, 1);
});

test('ContextBus: should generate project digest within token limit', () => {
  const bus = new ContextBus();
  for (let i = 0; i < 20; i++) {
    bus.set({
      key: `proj:fact:${i}`,
      value: `Some project fact number ${i} with a bit more detail here`,
      type: 'project-fact',
      author: 'test',
      tags: [],
      status: 'active',
    });
  }
  const digest = bus.getProjectDigest(500);
  assert.ok(digest.length <= 600, `digest length ${digest.length} > 600`);
  assert.ok(digest.includes('fact:0'), 'digest should contain fact:0');
});

test('ContextBus: should get relevant experience for agent type', () => {
  const bus = new ContextBus();
  bus.set({
    key: 'bug:null-db', value: 'DB query must be null-checked',
    type: 'known-issue', author: 'review-agent', tags: ['code-agent', 'prisma'], status: 'active',
  });
  bus.set({
    key: 'bug:css-flex', value: 'Flexbox gap not supported in older Safari',
    type: 'known-issue', author: 'test-agent', tags: ['frontend-agent', 'css'], status: 'active',
  });

  const codeExp = bus.getRelevantExperience('code-agent', 'Write a database query');
  assert.ok(codeExp.includes('null-db'), `expected null-db in: ${codeExp}`);
  assert.ok(!codeExp.includes('css-flex'), `should not have css-flex in: ${codeExp}`);

  const frontendExp = bus.getRelevantExperience('frontend-agent', 'Style the header');
  assert.ok(frontendExp.includes('css-flex'), `expected css-flex in: ${frontendExp}`);
  assert.ok(!frontendExp.includes('null-db'), `should not have null-db in: ${frontendExp}`);
});

test('ContextBus: should serialize and deserialize', () => {
  const bus = new ContextBus();
  bus.set({ key: 'a', value: 'hello', type: 'project-fact', author: 'x', tags: ['t'], status: 'active' });
  bus.set({ key: 'b', value: { nested: true }, type: 'convention', author: 'y', tags: [], status: 'active' });

  const json = bus.serialize();
  const restored = ContextBus.deserialize(json);

  assert.equal(restored.get('a')!.value, 'hello');
  assert.deepEqual(restored.get('b')!.value, { nested: true });
});

test('ContextBus: should archive entries by planId', () => {
  const bus = new ContextBus();
  bus.set({ key: 'a', value: 1, type: 'task-handoff', author: 'x', tags: [], planId: 'p1', status: 'active' });
  bus.set({ key: 'b', value: 2, type: 'task-handoff', author: 'y', tags: [], planId: 'p2', status: 'active' });

  const archived = bus.archive('p1');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].key, 'a');
  assert.equal(bus.get('a'), undefined);
  assert.ok(bus.get('b'));
});

test('ContextBus: should enforce max entries and LRU evict', () => {
  const smallBus = new ContextBus(5);
  for (let i = 0; i < 10; i++) {
    smallBus.set({ key: `k${i}`, value: i, type: 'project-fact', author: 'a', tags: [], status: 'active' });
  }
  assert.equal(smallBus.get('k0'), undefined);
  assert.ok(smallBus.get('k9'));
});

test('ContextBus: should get keys for new entries of a given type', () => {
  const bus = new ContextBus();
  bus.set({ key: 'k1', value: 1, type: 'convention', author: 'a', tags: [], status: 'active' });
  bus.set({ key: 'k2', value: 2, type: 'known-issue', author: 'b', tags: [], status: 'active' });

  const conventions = bus.getNewEntriesOfType('convention');
  assert.equal(conventions.length, 1);
});
