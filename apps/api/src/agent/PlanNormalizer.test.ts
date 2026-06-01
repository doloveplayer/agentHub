import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, validateBasic } from './PlanNormalizer.js';

test('normalizePlan accepts planner project and subject fields with suffixed agent types', () => {
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
