#!/usr/bin/env node
/**
 * planGen — Standardized plan.json generator for AgentHub.
 *
 * Runs inside the sandbox Docker container. The Planner agent pipes plan
 * data via stdin, and planGen validates, normalizes, and writes the
 * canonical plan.json to /workspace/plan.json.
 *
 * Modes:
 *   flat      Simple DAG task list with explicit dependsOn
 *   phased    Logical groups of tasks (phases), flattened to flat
 *   pipeline  Sequential stages with auto dependsOn chaining
 *
 * Usage:
 *   echo '<json>' | node /usr/local/bin/planGen.mjs --mode flat
 *   node /usr/local/bin/planGen.mjs --mode flat --input /tmp/plan_input.json
 *   node /usr/local/bin/planGen.mjs --help
 */

import { createRequire } from 'module';
import { writeFileSync, readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Bootstrap: resolve globally-installed zod (same pattern as sdk-runner.mjs)
// ---------------------------------------------------------------------------
const globalRequire = createRequire('/usr/local/lib/node_modules/');
const zodPath = globalRequire.resolve('zod');
const { z } = await import(zodPath);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(args) {
  const opts = { mode: '', input: '', dryRun: false, help: false, output: '/workspace/plan.json', agentTypes: '' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mode': opts.mode = args[++i] || ''; break;
      case '--input': opts.input = args[++i] || ''; break;
      case '--output': opts.output = args[++i] || '/workspace/plan.json'; break;
      case '--agent-types': opts.agentTypes = args[++i] || ''; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
    }
  }
  return opts;
}

const VALID_MODES = ['flat', 'phased', 'pipeline'];

function showHelp() {
  console.log(`planGen — AgentHub standardized plan.json generator

Usage:
  echo '<json>' | node planGen.mjs --mode <mode>
  node planGen.mjs --mode <mode> --input <path>

Modes:
  flat      Simple DAG: { planTitle, tasks: [...] }
  phased    Grouped by phase: { title, phases: [{ name, tasks: [...] }] }
  pipeline  Sequential stages: { title, stages: [{ name, tasks: [...] }] }
            Stage N tasks auto-depend on all tasks in stages 0..N-1

Options:
  --mode <mode>         Plan mode (required)
  --input <path>        Read input from file instead of stdin
  --output <path>       Output path (default: /workspace/plan.json)
  --agent-types <list>  Comma-separated allowed agentType values from cap-inventory
  --dry-run             Write to stdout instead of file
  --help, -h            Show this help

All modes produce the same canonical plan.json format:
  { planTitle, summary, tasks: [{ id, title, description, agentType,
     dependsOn, expectedOutput, risk }] }

IMPORTANT: Always pass --agent-types with the Schema Reference values from
cap-inventory.md. This prevents silent agent mismatches at dispatch time.
`);
}

// ---------------------------------------------------------------------------
// Field alias normalization — permissive input, strict output
// ---------------------------------------------------------------------------
const PLAN_ALIASES = {
  planTitle: ['planTitle', 'plan_title', 'project', 'title', 'planId', 'name'],
  summary:   ['summary', 'description', 'overview'],
};

const TASK_ALIASES = {
  id:             ['id', 'taskId', 'task_id'],
  title:          ['title', 'subject', 'name'],
  description:    ['description', 'desc', 'detail'],
  agentType:      ['agentType', 'agent_type', 'agent', 'assignedTo'],
  dependsOn:      ['dependsOn', 'depends_on', 'dependencies', 'depends'],
  expectedOutput: ['expectedOutput', 'expected_output', 'output', 'deliverable'],
  risk:           ['risk', 'priority', 'riskLevel'],
};

/** Pick the first defined value from the alias list. */
function pickAlias(obj, aliases) {
  for (const key of aliases) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/** Normalize a raw object using an alias map, returning only canonical keys. */
function normalizeObject(raw, aliasMap) {
  const out = {};
  for (const [canonical, aliases] of Object.entries(aliasMap)) {
    const val = pickAlias(raw, aliases);
    if (val !== undefined) out[canonical] = val;
  }
  return out;
}

function normalizeTask(raw) {
  const t = normalizeObject(raw, TASK_ALIASES);
  // Ensure required string fields exist so Zod's .min(1, ...) message fires
  t.id = t.id ?? '';
  t.title = t.title ?? '';
  t.agentType = t.agentType ?? '';
  // dependsOn: string[] or string → string[]
  if (typeof t.dependsOn === 'string') t.dependsOn = [t.dependsOn];
  if (!Array.isArray(t.dependsOn)) t.dependsOn = [];
  // risk: normalize "medium" and other values — keep only "high", default "low"
  if (t.risk !== 'high') t.risk = 'low';
  return t;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------
const taskSchema = z.object({
  id: z.string().min(1, 'task id is required'),
  title: z.string().min(1, 'task title is required'),
  description: z.string().default(''),
  agentType: z.string().min(1, 'agentType is required (must match cap-inventory)'),
  dependsOn: z.array(z.string()).default([]),
  expectedOutput: z.string().default(''),
  risk: z.enum(['low', 'high']).default('low'),
});

const canonicalOutputSchema = z.object({
  planTitle: z.string().min(1, 'planTitle is required'),
  summary: z.string().default(''),
  tasks: z.array(taskSchema).min(1, 'at least one task is required'),
});

// ===== MODE PROCESSORS ======================================================

/**
 * Flat mode: direct mapping.
 * Input: { planTitle, summary, tasks: [...] }
 */
function processFlat(raw) {
  const planMeta = normalizeObject(raw, PLAN_ALIASES);
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask) : [];
  return { planMeta, tasks };
}

/**
 * Phased mode: flatten phases into flat tasks.
 * Input: { title, description, phases: [{ name, tasks: [...] }] }
 */
function processPhased(raw) {
  const planMeta = normalizeObject(raw, PLAN_ALIASES);
  const tasks = [];
  if (Array.isArray(raw.phases)) {
    for (const phase of raw.phases) {
      if (Array.isArray(phase.tasks)) {
        for (const t of phase.tasks) {
          tasks.push(normalizeTask(t));
        }
      }
    }
  }
  return { planMeta, tasks };
}

/**
 * Pipeline mode: sequential stages with auto dependsOn.
 * Input: { title, description, stages: [{ name, tasks: [...] }] }
 *
 * Stage N tasks automatically depend on ALL tasks from stages 0..N-1,
 * merged with any explicitly declared dependsOn in the task.
 */
function processPipeline(raw) {
  const planMeta = normalizeObject(raw, PLAN_ALIASES);
  const allTasks = [];
  const stageTaskIds = []; // task IDs per stage, for auto-dependency

  if (Array.isArray(raw.stages)) {
    for (let si = 0; si < raw.stages.length; si++) {
      const stage = raw.stages[si];
      const stageTasks = [];
      if (Array.isArray(stage.tasks)) {
        for (const t of stage.tasks) {
          const task = normalizeTask(t);
          // Collect all task IDs from previous stages
          const prevIds = [];
          for (let pi = 0; pi < si; pi++) {
            prevIds.push(...stageTaskIds[pi]);
          }
          // Merge explicit dependsOn with auto-dependencies
          const merged = new Set([...task.dependsOn, ...prevIds]);
          task.dependsOn = [...merged];
          stageTasks.push(task.id);
          allTasks.push(task);
        }
      }
      stageTaskIds.push(stageTasks.map(t => typeof t === 'string' ? t : t.id));
    }
  }

  return { planMeta, tasks: allTasks };
}

// ===== CROSS-TASK VALIDATION ================================================

/**
 * Validate that all dependsOn references point to existing task IDs.
 * Returns an array of error strings (empty = valid).
 */
function validateCrossTaskRefs(tasks) {
  const ids = new Set(tasks.map(t => t.id));
  const errors = [];
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (!ids.has(depId)) {
        errors.push(`Cross-task: ${task.id} dependsOn references unknown task "${depId}"`);
      }
    }
  }
  return errors;
}

/**
 * Validate agentType against the allowed list from cap-inventory.
 * When --agent-types is provided, every task's agentType must match exactly
 * one of the allowed values. Returns an array of error strings (empty = valid).
 */
function validateAgentTypes(tasks, allowedRaw) {
  if (!allowedRaw || !allowedRaw.trim()) return []; // No restriction — skip
  const allowed = new Set(allowedRaw.split(',').map(s => s.trim()).filter(Boolean));
  if (allowed.size === 0) return [];
  const errors = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!allowed.has(t.agentType)) {
      errors.push(`agentType: task ${t.id || i} has agentType "${t.agentType}" which is not in the allowed list: [${[...allowed].join(', ')}]`);
    }
  }
  return errors;
}

// ===== ERROR FORMATTING =====================================================

function formatZodError(result, mode) {
  const lines = [];
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    lines.push(`  - ${path}: ${issue.message}`);
  }
  return `[planGen] VALIDATION FAILED (mode: ${mode}):\n${lines.join('\n')}\n\nFix errors above and retry.`;
}

// ===== MAIN =================================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) { showHelp(); process.exit(0); }

  if (!opts.mode) {
    console.error('[planGen] ERROR: --mode is required (flat, phased, pipeline)');
    console.error('  Run with --help for usage.');
    process.exit(1);
  }
  if (!VALID_MODES.includes(opts.mode)) {
    console.error(`[planGen] ERROR: Unknown mode "${opts.mode}". Valid modes: ${VALID_MODES.join(', ')}`);
    process.exit(1);
  }

  // Read input
  let inputRaw;
  try {
    if (opts.input) {
      inputRaw = readFileSync(opts.input, 'utf-8');
    } else {
      // Read from stdin
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      inputRaw = Buffer.concat(chunks).toString('utf-8');
    }
  } catch (err) {
    console.error(`[planGen] ERROR: Cannot read input: ${err.message}`);
    process.exit(1);
  }

  if (!inputRaw.trim()) {
    console.error('[planGen] ERROR: Empty input. Provide plan JSON via stdin or --input.');
    process.exit(1);
  }

  // Parse JSON
  let raw;
  try {
    raw = JSON.parse(inputRaw);
  } catch (err) {
    console.error(`[planGen] ERROR: Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  // Mode-specific processing
  let planMeta, tasks;
  switch (opts.mode) {
    case 'flat':     ({ planMeta, tasks } = processFlat(raw)); break;
    case 'phased':   ({ planMeta, tasks } = processPhased(raw)); break;
    case 'pipeline': ({ planMeta, tasks } = processPipeline(raw)); break;
  }

  if (tasks.length === 0) {
    console.error(`[planGen] VALIDATION FAILED (mode: ${opts.mode}):`);
    console.error('  - tasks: at least one task is required (no tasks found in input)');
    console.error('\nFix errors above and retry.');
    process.exit(1);
  }

  // Validate each task individually
  const taskErrors = [];
  const validatedTasks = [];
  for (let i = 0; i < tasks.length; i++) {
    const result = taskSchema.safeParse(tasks[i]);
    if (result.success) {
      validatedTasks.push(result.data);
    } else {
      for (const issue of result.error.issues) {
        taskErrors.push(`  - tasks[${i}].${issue.path.join('.')}: ${issue.message}`);
      }
    }
  }
  if (taskErrors.length > 0) {
    console.error(`[planGen] VALIDATION FAILED (mode: ${opts.mode}):`);
    console.error(taskErrors.join('\n'));
    console.error('\nFix errors above and retry.');
    process.exit(1);
  }

  // Cross-task validation
  const crossErrors = validateCrossTaskRefs(validatedTasks);
  if (crossErrors.length > 0) {
    console.error(`[planGen] VALIDATION FAILED (mode: ${opts.mode}):`);
    for (const e of crossErrors) console.error(`  - ${e}`);
    console.error('\nFix errors above and retry.');
    process.exit(1);
  }

  // Agent-type validation (only when --agent-types is provided)
  const agentTypeErrors = validateAgentTypes(validatedTasks, opts.agentTypes);
  if (agentTypeErrors.length > 0) {
    console.error(`[planGen] VALIDATION FAILED — agentType mismatch:`);
    for (const e of agentTypeErrors) console.error(`  - ${e}`);
    console.error('\nYour agentType values MUST match the Schema Reference in cap-inventory.md.');
    console.error('Do NOT append session IDs or suffixes to agentType.');
    console.error('Fix errors above and retry.');
    process.exit(1);
  }

  // Build canonical output
  const canonical = {
    planTitle: planMeta.planTitle || 'Untitled Plan',
    summary: planMeta.summary || '',
    tasks: validatedTasks,
  };

  const finalResult = canonicalOutputSchema.safeParse(canonical);
  if (!finalResult.success) {
    console.error(formatZodError(finalResult, opts.mode));
    process.exit(1);
  }

  const output = JSON.stringify(finalResult.data, null, 2);

  if (opts.dryRun) {
    console.log(output);
  } else {
    writeFileSync(opts.output, output, 'utf-8');
    console.log(`[planGen] Wrote ${finalResult.data.tasks.length} task(s) to ${opts.output} (mode: ${opts.mode})`);
  }
}

main().catch(err => {
  console.error(`[planGen] FATAL: ${err.message}`);
  process.exit(1);
});
