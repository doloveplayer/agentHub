import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeploymentFiles,
  parseNpmAuditJson,
  parseReviewReport,
  parseTestOutput,
} from './ArtifactTools.js';

test('buildDeploymentFiles creates Docker deployment assets with env placeholders', () => {
  const files = buildDeploymentFiles({
    appName: 'demo-app',
    startCommand: 'npm start',
    buildCommand: 'npm run build',
    env: ['DATABASE_URL', 'JWT_SECRET'],
  });

  assert.match(files.dockerfile, /npm run build/);
  assert.match(files.compose, /demo-app/);
  assert.match(files.envExample, /DATABASE_URL=/);
  assert.match(files.envExample, /JWT_SECRET=/);
});

test('parseNpmAuditJson groups vulnerabilities by severity and keeps CVE identifiers', () => {
  const report = parseNpmAuditJson(JSON.stringify({
    vulnerabilities: {
      lodash: {
        name: 'lodash',
        severity: 'high',
        via: [{ source: 1, title: 'Prototype Pollution', url: 'https://example.test/CVE-2024-0001', cve: 'CVE-2024-0001' }],
        range: '<4.17.21',
        fixAvailable: true,
      },
    },
    metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 } },
  }));

  assert.equal(report.total, 1);
  assert.equal(report.bySeverity.high.length, 1);
  assert.deepEqual(report.bySeverity.high[0]?.cves, ['CVE-2024-0001']);
});

test('parseTestOutput extracts pass/fail counts, duration, and failed stack excerpts', () => {
  const report = parseTestOutput(`PASS src/a.test.ts
FAIL src/b.test.ts
  expected true to be false

Tests: 1 failed, 2 passed, 3 total
Time: 4.21 s`);

  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.total, 3);
  assert.equal(report.durationMs, 4210);
  assert.equal(report.cases.find((item) => item.status === 'failed')?.name, 'src/b.test.ts');
});

test('parseReviewReport extracts severity, file line, and finding text', () => {
  const report = parseReviewReport(`HIGH apps/api/src/index.ts:42 Missing auth check
WARNING apps/web/src/App.tsx:9 Render branch is unreachable
SUGGESTION docs/README.md:3 Clarify setup`);

  assert.equal(report.findings.length, 3);
  assert.equal(report.findings[0]?.severity, 'high');
  assert.equal(report.findings[0]?.file, 'apps/api/src/index.ts');
  assert.equal(report.findings[0]?.line, 42);
});
