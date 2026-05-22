import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudePrintArgs,
  extractPlannerPlan,
  matchAgentByHandle,
  normalizeAgentHandle,
  selectDefaultAgent,
  toTaskStates,
} from './turns.js';
import type { AgentConfig, SessionAgentInfo } from '@agenthub/shared';

const agents: AgentConfig[] = [
  {
    id: 'code-id',
    name: 'code-agent',
    displayName: 'CodeAgent',
    description: 'writes code',
    systemPrompt: 'code prompt',
  },
  {
    id: 'review-id',
    name: 'review-agent',
    displayName: 'ReviewAgent',
    description: 'reviews code',
    systemPrompt: 'review prompt',
  },
  {
    id: 'planner-id',
    name: 'planner',
    displayName: 'Planner',
    description: 'plans work',
    systemPrompt: 'planner prompt',
  },
];

const sessionAgents: SessionAgentInfo[] = agents.map((agent) => ({
  agentId: agent.id,
  name: agent.name,
  displayName: agent.displayName,
}));

test('normalizeAgentHandle removes case, separators, and punctuation', () => {
  assert.equal(normalizeAgentHandle('CodeAgent'), 'codeagent');
  assert.equal(normalizeAgentHandle('code-agent'), 'codeagent');
  assert.equal(normalizeAgentHandle('@Review_Agent!'), 'reviewagent');
});

test('matchAgentByHandle accepts display names, kebab names, and prefixes', () => {
  assert.equal(matchAgentByHandle('CodeAgent', agents)?.id, 'code-id');
  assert.equal(matchAgentByHandle('code-agent', agents)?.id, 'code-id');
  assert.equal(matchAgentByHandle('code', agents)?.id, 'code-id');
  assert.equal(matchAgentByHandle('ReviewAgent', agents)?.id, 'review-id');
  assert.equal(matchAgentByHandle('missing', agents), null);
});

test('selectDefaultAgent routes solo sessions to CodeAgent', () => {
  const selected = selectDefaultAgent('solo', sessionAgents, agents);
  assert.equal(selected?.id, 'code-id');
});

test('selectDefaultAgent routes group sessions to Planner by default', () => {
  const selected = selectDefaultAgent('group', sessionAgents, agents);
  assert.equal(selected?.id, 'planner-id');
});

test('selectDefaultAgent falls back to the first session agent when Planner is unavailable', () => {
  const selected = selectDefaultAgent('group', sessionAgents.slice(0, 2), agents.slice(0, 2));
  assert.equal(selected?.id, 'code-id');
});

test('buildClaudePrintArgs only skips permissions when trust mode is enabled', () => {
  const trusted = buildClaudePrintArgs(true);
  const untrusted = buildClaudePrintArgs(false);

  assert.ok(trusted.includes('--dangerously-skip-permissions'));
  assert.ok(!untrusted.includes('--dangerously-skip-permissions'));
  assert.ok(trusted.includes('--print'));
  assert.ok(untrusted.includes('--print'));
});

test('extractPlannerPlan parses fenced JSON plans', () => {
  const plan = extractPlannerPlan(`Here is the plan:

\`\`\`json
{
  "planTitle": "Build auth",
  "summary": "Add login",
  "tasks": [
    {
      "id": "task-1",
      "title": "Implement API",
      "description": "Create auth route",
      "agentType": "CodeAgent",
      "dependsOn": [],
      "expectedOutput": "src/auth.ts",
      "priority": "high"
    }
  ]
}
\`\`\``);

  assert.equal(plan?.planTitle, 'Build auth');
  assert.equal(plan?.tasks[0]?.id, 'task-1');
});

test('extractPlannerPlan parses plain JSON plans and ignores normal chat', () => {
  const plan = extractPlannerPlan('{"planTitle":"Plain","summary":"","tasks":[{"id":"task-1","title":"A","description":"B","agentType":"CodeAgent","dependsOn":[],"expectedOutput":"x","priority":"medium"}]}');
  assert.equal(plan?.planTitle, 'Plain');
  assert.equal(extractPlannerPlan('I can help you think through that.'), null);
});

test('toTaskStates normalizes planner tasks for the frontend DAG contract', () => {
  const plan = extractPlannerPlan('{"planTitle":"Plain","summary":"","tasks":[{"id":"task-1","title":"A","description":"B","agentType":"CodeAgent","dependsOn":[],"expectedOutput":"x","priority":"medium"}]}');
  assert.ok(plan);

  const tasks = toTaskStates(plan, 'plan-123');

  assert.deepEqual(tasks, [
    {
      taskId: 'task-1',
      planId: 'plan-123',
      title: 'A',
      agentType: 'CodeAgent',
      status: 'waiting',
      dependsOn: [],
      expectedOutput: 'x',
      priority: 'medium',
      description: 'B',
    },
  ]);
});
