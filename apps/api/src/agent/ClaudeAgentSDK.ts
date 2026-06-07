import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ParsedEvent } from "./EventParser.js";

export type AgentPermissionProfile = "read_only" | "accept_edits" | "default" | "bypass";

export function mapPermissionMode(profile: AgentPermissionProfile): PermissionMode {
  switch (profile) {
    case "read_only": return "default";
    case "accept_edits": return "acceptEdits";
    case "default": return "default";
    case "bypass": return "bypassPermissions";
  }
}

export function mapAllowedTools(profile: AgentPermissionProfile): string[] {
  switch (profile) {
    case "read_only": return ["Read", "Grep", "Glob", "Bash"];
    case "accept_edits": return ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "NotebookEdit"];
    case "default": return []; // empty: all tools fall through to control_request in "default" mode
    case "bypass": return [];
  }
}

export interface SDKStreamOptions {
  cwd: string;
  model?: string;
  resume?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat?: Options["outputFormat"];
  skills?: string[];
  thinking?: Options["thinking"];
  effort?: Options["effort"];
  abortController?: AbortController;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string | undefined>;
  systemPrompt?: string;
  settingSources?: Options["settingSources"];
  includePartialMessages?: boolean;
  persistSession?: boolean;
}

export interface SDKResult {
  sessionId: string;
  output: string;
  exitCode: number;
  structuredOutput?: unknown;
}

export class ClaudeAgentSDK {
  private controller: AbortController | null = null;

  async stream(
    prompt: string,
    options: SDKStreamOptions,
    onEvent: (event: ParsedEvent) => void,
  ): Promise<SDKResult> {
    this.controller = options.abortController ?? new AbortController();

    const sdkOptions: Options = {
      cwd: options.cwd,
      model: options.model,
      resume: options.resume,
      permissionMode: options.permissionMode ?? "default",
      allowedTools: options.allowedTools ?? [],
      disallowedTools: options.disallowedTools,
      skills: options.skills,
      thinking: options.thinking,
      effort: options.effort,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      env: options.env,
      systemPrompt: options.systemPrompt,
      settingSources: options.settingSources ?? ["user", "project"],
      includePartialMessages: options.includePartialMessages,
      persistSession: options.persistSession ?? true,
      abortController: this.controller,
    };

    if (options.outputFormat) {
      sdkOptions.outputFormat = options.outputFormat;
    }

    if (options.permissionMode === "bypassPermissions") {
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    let sessionId = options.resume ?? "";
    let outputText = "";
    let structuredOutput: unknown;
    let finalSubtype: string | undefined;

    try {
      for await (const message of query({ prompt, options: sdkOptions })) {
        // Capture session ID from any message that carries it
        const msg = message as Record<string, unknown>;
        const msgType = typeof msg.type === "string" ? msg.type : "";
        const sid = msg.session_id;
        if (typeof sid === "string" && sid) sessionId = sid;

        switch (msgType) {
          case "assistant": {
            const blocks = (msg.message as any)?.content;
            if (!Array.isArray(blocks)) break;
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string") {
                outputText += block.text;
                onEvent({ type: "text", content: block.text });
              } else if (block.type === "tool_use") {
                onEvent({
                  type: "tool_use",
                  toolName: block.name ?? "unknown",
                  input: (block.input ?? {}) as Record<string, unknown>,
                });
              }
            }
            break;
          }
          case "tool_result": {
            const content = typeof msg.content === "string" ? msg.content : "";
            if (content) {
              onEvent({ type: "tool_result", content });
            }
            break;
          }
          case "result": {
            finalSubtype = typeof msg.subtype === "string" ? msg.subtype : undefined;
            if (finalSubtype === "success") {
              structuredOutput = msg.structured_output;
              const resultText = typeof msg.result === "string" ? msg.result : "";
              if (resultText && resultText !== outputText) {
                onEvent({ type: "text", content: resultText });
                outputText += resultText;
              }
            } else if (finalSubtype !== "success" && finalSubtype) {
              const errors = Array.isArray(msg.errors)
                ? (msg.errors as string[]).join("; ")
                : (finalSubtype ?? "Agent run failed");
              onEvent({ type: "error", message: errors || "Agent run failed" });
            }
            break;
          }
          case "system": {
            const sub = typeof msg.subtype === "string" ? msg.subtype : "";
            const sysMsg = typeof msg.message === "string" ? msg.message : "";

            // Forward token usage from system init events
            if (sub === "init" && msg.session_id) {
              sessionId = msg.session_id as string;
            }
            onEvent({ type: "system", subtype: sub, message: sysMsg, sessionId });
            break;
          }
          case "stream_event": {
            // SDK may emit stream_event for incremental updates
            const streamEvent = msg.event as Record<string, unknown> | undefined;
            if (streamEvent?.type === "content_block_delta" && streamEvent?.delta) {
              const delta = streamEvent.delta as Record<string, unknown>;
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
                onEvent({ type: "text", content: delta.text });
              }
            } else if (streamEvent?.type === "content_block_start" && streamEvent?.content_block) {
              const block = streamEvent.content_block as Record<string, unknown>;
              if (block.type === "tool_use" && typeof block.name === "string") {
                onEvent({ type: "tool_use", toolName: block.name, input: (block.input ?? {}) as Record<string, unknown> });
              }
            }
            break;
          }
          default: {
            // Log unrecognized event types for diagnostics — don't crash
            if (msgType && msgType !== "user" && msgType !== "auth_status") {
              console.log(`[sdk:unhandled] type=${msgType}`);
            }
            break;
          }
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError" || this.controller?.signal.aborted) {
        return { sessionId, output: outputText, exitCode: 1 };
      }
      onEvent({ type: "error", message: error.message ?? String(error) });
      return { sessionId, output: outputText, exitCode: 1 };
    }

    const success = finalSubtype === "success";
    return {
      sessionId,
      output: outputText,
      exitCode: success ? 0 : 1,
      structuredOutput,
    };
  }

  kill(): void {
    this.controller?.abort("cancelled");
  }
}
