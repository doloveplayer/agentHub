import { SandboxManager } from './SandboxManager.js';

export interface ProjectContext {
  fileTree: string;
  pkgJson: Record<string, unknown> | null;
}

/** Probe the project structure inside a sandbox container */
export async function probeProjectContext(
  containerId: string,
): Promise<ProjectContext> {
  const fileTree = await SandboxManager.execCapture(
    containerId,
    'find . -not -path "*/node_modules/*" -not -path "*/.git/*" -type f 2>/dev/null | head -100',
  );

  const pkgContent = await SandboxManager.execCapture(
    containerId,
    'cat package.json 2>/dev/null || echo "{}"',
  );

  let pkgJson: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(pkgContent);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      pkgJson = parsed;
    }
  } catch { /* malformed json, ignore */ }

  return { fileTree, pkgJson };
}

/** Build an enriched context prompt for a task */
export function buildContextPrompt(
  taskTitle: string,
  taskDescription: string,
  expectedOutput: string,
  context: ProjectContext,
  previousTaskOutputs?: { title: string; expectedOutput: string }[],
): string {
  const depsInfo = previousTaskOutputs?.length
    ? `Previous tasks completed:\n${previousTaskOutputs.map(d =>
        `- ${d.title}: see ${d.expectedOutput}`).join('\n')}\n`
    : '';

  const pkgInfo = context.pkgJson
    ? `Project: ${context.pkgJson.name || 'unknown'} — deps: ${Object.keys(context.pkgJson.dependencies || {}).join(', ') || 'none'}`
    : '';

  return `Task: ${taskTitle}
Description: ${taskDescription}
Expected Output: ${expectedOutput}

Project Structure:
${context.fileTree}

${pkgInfo ? `${pkgInfo}\n` : ''}
${depsInfo}
Execute this task now. Output the results to the specified files.`;
}
