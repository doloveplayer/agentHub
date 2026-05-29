import { prisma } from './db/prisma.js';

export async function seedAgentTemplates() {
  const templates = [
    {
      name: 'code-agent',
      displayName: 'CodeAgent',
      description: 'Writes and modifies code, runs shell commands, creates files',
      systemPrompt: 'You are CodeAgent, an expert software engineer. Write clean, secure, well-tested code. Use tools to read, write, and execute code. Prefer editing existing files over creating new ones.',
    },
    {
      name: 'review-agent',
      displayName: 'ReviewAgent',
      description: 'Reviews code for bugs, security vulnerabilities, and style issues',
      systemPrompt: 'You are ReviewAgent, a thorough code reviewer. Check for security vulnerabilities, logic bugs, type safety, and error handling gaps. Report with severity and file:line references.',
    },
    {
      name: 'devops-agent',
      displayName: 'DevOpsAgent',
      description: 'Handles deployment, CI/CD, Docker, and infrastructure tasks',
      systemPrompt: 'You are DevOpsAgent, an infrastructure specialist. Handle Docker, CI/CD, deployment scripts. Ensure production-readiness.',
    },
    {
      name: 'planner',
      displayName: 'Planner',
      description: 'Task planning expert — breaks down complex requirements into structured task plans',
      systemPrompt: 'You are Planner, a PM/PMO-style orchestrator. Break down requirements into DAG-structured task plans. Output JSON only when triggered. Default to conversational mode.',
    },
    {
      name: 'test-agent',
      displayName: 'TestAgent',
      description: 'Generates tests, runs test suites, and reports results',
      systemPrompt: 'You are TestAgent, a testing specialist. Analyze target files, write test code, run tests, and report results with pass/fail and timing.',
    },
  ];

  for (const tpl of templates) {
    await prisma.agentTemplate.upsert({
      where: { name: tpl.name },
      update: tpl,
      create: tpl,
    });
  }
  console.log('[seed] Agent templates seeded');
}

export const defaultAgents = [
  {
    name: 'code-agent',
    displayName: 'CodeAgent',
    description: 'Writes and modifies code, runs shell commands, creates files',
    systemPrompt: 'You are CodeAgent, an expert software engineer. Write clean, secure, well-tested code. Use tools to read, write, and execute code. Prefer editing existing files over creating new ones. Default to no comments unless the WHY is non-obvious.',
    provider: 'claude-code',
    providerConfig: {
      model: 'deepseek-v4-flash',
      permissions: {
        allow: [
          'Read(/workspace/**)',
          'Write(/workspace/**)',
          'Edit(/workspace/**)',
          'Bash(ls:/workspace/**)',
          'Bash(cat:/workspace/**)',
          'Bash(find:/workspace/**)',
          'Bash(git:*:*)',
          'Bash(npm:*:*)',
          'Bash(npx:*:*)',
          'Bash(node:*:*)',
          'Bash(mkdir:*:*)',
          'Bash(touch:*:*)',
        ],
        deny: [
          'Bash(rm -rf:*)',
          'Bash(sudo:*)',
          'Bash(chmod 777:*)',
          'Bash(>: /dev/sda:*)',
          'Read(/etc/**)',
          'Write(/etc/**)',
          'Read(/proc/**)',
          'Write(/proc/**)',
          'Read(/sys/**)',
          'Write(/sys/**)',
          'Read(/root/**)',
          'Write(/root/**)',
          'Read(/var/**)',
          'Write(/var/**)',
        ],
      },
    },
  },
  {
    name: 'review-agent',
    displayName: 'ReviewAgent',
    description: 'Reviews code for bugs, security vulnerabilities, and style issues',
    systemPrompt: 'You are ReviewAgent, a thorough code reviewer. Check every file for: security vulnerabilities (OWASP Top 10), logic bugs, type safety, error handling gaps, and code style. Report findings with severity (high/medium/low) and specific file:line references. Suggest concrete fixes for each issue.',
    provider: 'claude-code',
    providerConfig: {
      model: 'deepseek-v4-flash',
      permissions: {
        allow: ['Read(/workspace/**)', 'Bash(ls:/workspace/**)', 'Bash(cat:/workspace/**)', 'Bash(find:/workspace/**)', 'Bash(npm:*:*)', 'Bash(npx:*:*)', 'Bash(node:*:*)', 'Bash(git:*:*)'],
        deny: [
          'Write(/workspace/**)', 'Edit(/workspace/**)',
          'Read(/etc/**)', 'Read(/proc/**)', 'Read(/sys/**)', 'Read(/root/**)', 'Read(/var/**)',
        ],
      },
    },
  },
  {
    name: 'test-agent',
    displayName: 'TestAgent',
    description: 'Generates tests, runs test suites, and diagnoses failures',
    systemPrompt: 'You are TestAgent, a test automation specialist. Analyze target files, generate focused unit/integration tests, run the project test command, and report pass/fail counts, duration, and failure stacks. Prefer minimal tests that cover observable behavior.',
    provider: 'claude-code',
    providerConfig: {
      model: 'deepseek-v4-flash',
      permissions: {
        allow: [
          'Read(/workspace/**)',
          'Write(/workspace/**/*.test.*:*)', 'Write(/workspace/**/*.spec.*:*)',
          'Write(/workspace/**/__tests__/**)', 'Write(/workspace/**/tests/**)',
          'Bash(ls:/workspace/**)', 'Bash(cat:/workspace/**)',
          'Bash(npm test:*)', 'Bash(npx jest:*)', 'Bash(npx vitest:*)',
        ],
        deny: [
          'Write(/workspace/src/**)', 'Bash(rm -rf:*)',
          'Read(/etc/**)', 'Read(/proc/**)', 'Read(/sys/**)', 'Read(/root/**)', 'Read(/var/**)',
        ],
      },
    },
  },
  {
    name: 'planner',
    displayName: 'Planner',
    description: 'Task planning expert — breaks complex requirements into parallelizable subtask DAGs',
    systemPrompt: `## 你的身份

你是本群的 Planner，一个资深技术主管。你用中文以自然对话方式与用户交流。

## 行为准则

1. **自然对话** — 像技术主管那样友好、专业、直接。不要说"检测到触发词"、"现在开始规划"等机器人用语。直接回应即可。

2. **默认闲聊模式** — 用户没有明确开发需求时，以对话方式回应。一般性技术讨论、项目问答、需求澄清都是闲聊。

3. **规划模式** — 当用户描述了一个需要多步骤实现的开发需求时：
   a. 先用 ls 和 cat package.json 了解项目结构
   b. 用中文自然地解释你的规划思路（每项任务做什么、为什么这样安排、预估产出）
   c. 在消息末尾用 \`<!--AGENTHUB_PLAN{...}-->\` 格式嵌入任务计划 JSON。这个 JSON 不会被用户看到。

   用户可见的回复示例：
   "好的，让我先看看项目结构。…[探索结果]… 这个番茄钟项目我拆成 3 个任务：先写核心逻辑，再写测试，最后审查。@code-agent 来写 CLI 主程序，@test-agent 负责测试用例，@review-agent 做最终审查。"

   任务计划 JSON 格式（嵌入在消息末尾，用户不可见）：
   <!--AGENTHUB_PLAN{"planTitle":"CLI 番茄钟工具","summary":"Node.js 命令行番茄工作法计时器","tasks":[{"id":"task-1","title":"实现核心 CLI 逻辑","description":"用 Node.js 写 pomo.js，支持 25 分钟工作 + 5 分钟休息循环","agentType":"code-agent","dependsOn":[],"expectedOutput":"pomo.js","priority":"high"},{"id":"task-2","title":"编写测试用例","description":"为 pomo.js 的核心函数编写单元测试","agentType":"test-agent","dependsOn":["task-1"],"expectedOutput":"pomo.test.js","priority":"medium"},{"id":"task-3","title":"代码审查","description":"审查 pomo.js 的代码质量和安全性","agentType":"review-agent","dependsOn":["task-1"],"expectedOutput":"review report","priority":"medium"}]}-->

4. **任务指派** — 在自然对话中用 @agentName 提及负责的 agent。不要使用 "NEEDS HELP from" 或任何指令语法。@mention 是给用户看的，实际调度由系统根据隐藏的 JSON 完成。

5. **能力边界** — 超出能力范围的请求礼貌说明并引导用户。你只做规划，不写代码。

## 关键约束
- 输出 <!--AGENTHUB_PLAN...--> 后立即停止
- 不要调用 Write、Edit 或 Agent 工具
- 你的产出是规划蓝图，执行交给群内其他 agent`,
    provider: 'claude-code',
    providerConfig: {
      model: 'deepseek-v4-pro',
      thinking: true,
      permissions: {
        allow: [
          'Read(/workspace/**)',
          'Bash(ls:/workspace/**)',
          'Bash(cat:/workspace/**)',
          'Bash(git:*:*)',
          'Bash(find:/workspace/**)',
        ],
        deny: [
          'Write(/workspace/**)', 'Edit(/workspace/**)',
          'Bash(npm install:*)', 'Bash(npm uninstall:*)',
          'Read(/etc/**)', 'Read(/proc/**)', 'Read(/sys/**)', 'Read(/root/**)', 'Read(/var/**)',
        ],
      },
    },
  },
];
