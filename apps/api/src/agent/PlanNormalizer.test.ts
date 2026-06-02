import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, validateBasic } from './PlanNormalizer.js';

test('normalizePlan accepts flat format with suffixed agent types', () => {
  const plan = normalizePlan({
    project: 'PawCare Clinic Hub Frontend Prototype',
    tasks: [
      {
        id: '1',
        subject: '初始化 Vite + React + TypeScript 项目',
        description: 'Create the frontend project',
        agentType: 'code-agent-8abd2c04',
        dependencies: [],
        risk: 'low',
      },
    ],
  });

  assert.equal(plan.planTitle, 'PawCare Clinic Hub Frontend Prototype');
  assert.equal(plan.tasks[0].title, '初始化 Vite + React + TypeScript 项目');
  assert.equal(plan.tasks[0].agentType, 'code-agent');
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.deepEqual(validateBasic(plan), { valid: true });
});

test('normalizePlan flattens phased structure into flat tasks', () => {
  const plan = normalizePlan({
    title: '定时器代码可用性审查',
    description: '对 countdown.js 进行全面的可用性审查',
    phases: [
      {
        id: 'phase-1',
        name: '深度代码审查',
        tasks: [
          {
            id: 'task-1-1',
            title: 'parseTime 解析逻辑审查',
            description: '审查 parseTime 函数',
            agentType: 'code-reviewer',
            depends_on: [],
            risk: 'low',
          },
          {
            id: 'task-1-2',
            title: '定时器引擎审查',
            description: '审查 startCountdown',
            agentType: 'code-reviewer',
            depends_on: ['task-1-1'],
            risk: 'low',
          },
        ],
      },
      {
        id: 'phase-2',
        name: '功能测试',
        tasks: [
          {
            id: 'task-2-1',
            title: '单元测试执行',
            description: '编写测试',
            agentType: 'tester',
            depends_on: ['task-1-1'],
            risk: 'low',
          },
        ],
      },
    ],
  });

  assert.equal(plan.planTitle, '定时器代码可用性审查');
  assert.equal(plan.summary, '对 countdown.js 进行全面的可用性审查');
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.tasks[0].id, 'task-1-1');
  assert.equal(plan.tasks[0].agentType, 'code-reviewer');
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.equal(plan.tasks[1].agentType, 'code-reviewer');
  assert.deepEqual(plan.tasks[1].dependsOn, ['task-1-1']);
  assert.equal(plan.tasks[2].agentType, 'tester');
  assert.deepEqual(plan.tasks[2].dependsOn, ['task-1-1']);
  assert.deepEqual(validateBasic(plan), { valid: true });
});
