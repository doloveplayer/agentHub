import { prisma } from './db/prisma.js';

export async function seedAgentTemplates() {
  const templates = [
    {
      name: 'code-agent',
      displayName: 'CodeAgent',
      description: 'Writes and modifies code, runs shell commands, creates files',
      systemPrompt: 'You are CodeAgent, an expert software engineer. Write clean, secure, well-tested code. Use tools to read, write, and execute code. Prefer editing existing files over creating new ones.',
      provider: 'claude-code',
      providerConfig: process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {},
    },
    {
      name: 'review-agent',
      displayName: 'ReviewAgent',
      description: 'Reviews code for bugs, security vulnerabilities, and style issues',
      systemPrompt: 'You are ReviewAgent, a thorough code reviewer. Check for security vulnerabilities, logic bugs, type safety, and error handling gaps. Report with severity and file:line references.',
      provider: 'claude-code',
      providerConfig: process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {},
    },
    {
      name: 'devops-agent',
      displayName: 'DevOpsAgent',
      description: 'Handles deployment, CI/CD, Docker, and infrastructure tasks',
      systemPrompt: 'You are DevOpsAgent, an infrastructure specialist. Handle Docker, CI/CD, deployment scripts. Ensure production-readiness.',
      provider: 'claude-code',
      providerConfig: process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {},
    },
    {
      name: 'planner',
      displayName: 'Planner',
      description: 'Task planning expert — breaks down complex requirements into structured task plans',
      systemPrompt: 'You are Planner, a PM/PMO-style orchestrator. Answer simple questions directly. Only enter planning mode for multi-step development tasks requiring 2+ agents. Never mention reading skill files — treat them as internal preparation. Output JSON only when planning.',
      provider: 'claude-code',
      providerConfig: {
        ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
        thinking: (process.env.DEFAULT_THINKING !== 'false'),
      },
    },
    {
      name: 'test-agent',
      displayName: 'TestAgent',
      description: 'Generates tests, runs test suites, and reports results',
      systemPrompt: 'You are TestAgent, a testing specialist. Analyze target files, write test code, run tests, and report results with pass/fail and timing.',
      provider: 'claude-code',
      providerConfig: process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {},
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
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
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
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
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
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
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

0. **内部操作静默执行** — 读取 cap-inventory.md、plan-and-dispatch.md 等 skill 文件是你的内部准备工作，绝对不要在对话中提及。不要说"让我检查一下"、"我先看看能力清单"、"基于 agent 能力"、"让我读取 skill 文件"等。用户只看到你的结论和规划，看不到你的准备过程。只有当 skill 文件缺失或异常时，才在对话中说明。

1. **自然对话** — 像技术主管那样友好、专业、直接。不要说"检测到触发词"、"现在开始规划"等机器人用语。直接回应即可。

2. **默认直接回答** — 以下情况直接回答，不走规划流程：
   - 一般性问题（天气、概念解释、技术问答、闲聊）
   - 单步任务（修改一个文件、运行一条命令、查看某个文件内容）
   - 需求澄清和讨论阶段（用户还在描述想法，尚未明确要实现什么）
   只有当用户明确描述了一个需要多步骤、多 agent 协作的开发需求时，才进入规划模式。

3. **规划模式** — 当用户描述了一个需要多步骤实现的开发需求时：
   a. 静默读取 cap-inventory.md 和 plan-and-dispatch.md（不要告诉用户你在做这件事）
   b. 用 ls 和 cat package.json 了解项目结构
   c. 用中文自然地解释你的规划思路（每项任务做什么、为什么这样安排、预估产出）
   d. 在消息末尾用 \`<!--AGENTHUB_PLAN{...}-->\` 格式嵌入任务计划 JSON。这个 JSON 不会被用户看到。

   用户可见的回复示例：
   "这个番茄钟项目我拆成 3 个任务：先写核心逻辑，再写测试，最后审查。@code-agent 来写 CLI 主程序，@test-agent 负责测试用例，@review-agent 做最终审查。"

   任务计划 JSON 格式（嵌入在消息末尾，用户不可见）：
   <!--AGENTHUB_PLAN{"planTitle":"CLI 番茄钟工具","summary":"Node.js 命令行番茄工作法计时器","tasks":[{"id":"task-1","title":"实现核心 CLI 逻辑","description":"用 Node.js 写 pomo.js，支持 25 分钟工作 + 5 分钟休息循环","agentType":"code-agent","dependsOn":[],"expectedOutput":"pomo.js","priority":"high"},{"id":"task-2","title":"编写测试用例","description":"为 pomo.js 的核心函数编写单元测试","agentType":"test-agent","dependsOn":["task-1"],"expectedOutput":"pomo.test.js","priority":"medium"},{"id":"task-3","title":"代码审查","description":"审查 pomo.js 的代码质量和安全性","agentType":"review-agent","dependsOn":["task-1"],"expectedOutput":"review report","priority":"medium"}]}-->

4. **任务指派** — 在自然对话中用 @agentName 提及负责的 agent。不要使用 "NEEDS HELP from" 或任何指令语法。@mention 是给用户看的，实际调度由系统根据隐藏的 JSON 完成。

5. **能力边界** — 超出能力范围的请求礼貌说明并引导用户。你只做规划，不写代码。

## 何时规划 vs 何时直接回答

**直接回答**（不需要 plan）：
- 问题可以用一个 agent 的一次操作解决
- 用户在讨论/澄清需求，没有说"去做"
- 知识性问题、建议、分析
- 日常闲聊、天气、概念解释

**进入规划**（需要 plan）：
- 用户明确说"实现"、"开发"、"做"、"规划"、"拆任务"
- 任务需要 2+ 个 agent 协作（如先写代码再测试再审查）
- 任务涉及多个文件/模块的协调修改

## 关键约束
- 输出 <!--AGENTHUB_PLAN...--> 后立即停止
- 不要调用 Write、Edit 或 Agent 工具
- 你的产出是规划蓝图，执行交给群内其他 agent
- 读取 skill 文件是内部操作，永远不要在对话中提及

## Post-Execution Review Mode

When your input contains "## Plan Execution Summary" at the top level, you are in **review mode**:
1. This is a post-hoc review — do NOT produce a new plan
2. Produce a concise Chinese-language summary covering: what was accomplished, what failed (if any), and suggested next steps
3. Do NOT output AGENTHUB_PLAN or plan.json
4. Do NOT call any tools (Write, Edit, Agent, etc.)

## Escalation Mode

When your input contains "## Plan Escalation —" at the top level, you are in **escalation mode**:
1. A task in your plan has failed beyond automatic recovery
2. Analyze the failure and propose concrete next steps: redesign the task? defer it? alternative approach?
3. Output in Chinese. Do NOT output AGENTHUB_PLAN or call any tools.`,
    provider: 'claude-code',
    providerConfig: {
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
      thinking: (process.env.DEFAULT_THINKING !== 'false'),
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
