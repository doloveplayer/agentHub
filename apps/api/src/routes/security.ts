import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { SandboxManager } from "../agent/SandboxManager.js";
import { parseNpmAuditJson } from "../artifacts/ArtifactTools.js";
import { broadcast } from "../ws/state.js";
import { getSessionContainer } from "./sessionContainer.js";

const security = new Hono();
security.use("*", authMiddleware);

security.post("/:sessionId/audit", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: "Sandbox not ready" }, 404);
  let output = "";
  const result = await SandboxManager.execStream(
    containerId,
    ["sh", "-lc", "npm audit --json"],
    {
      workDir: "/workspace",
      onStdout: (chunk) => {
        output += chunk;
      },
      onStderr: (chunk) => {
        output += chunk;
      },
    },
  );
  const report = parseNpmAuditJson(extractJson(output));
  broadcast(sessionId, {
    type: "security_report",
    report,
    exitCode: result.exitCode,
    timestamp: Date.now(),
  });
  return c.json({ report, exitCode: result.exitCode });
});

security.post("/:sessionId/upgrade", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: "Sandbox not ready" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const command = body.packageName
    ? `npm install ${String(body.packageName).replace(/[^a-zA-Z0-9@/._-]/g, "")}@latest`
    : "npm audit fix";
  let output = "";
  const result = await SandboxManager.execStream(
    containerId,
    ["sh", "-lc", command],
    {
      workDir: "/workspace",
      onStdout: (chunk) => {
        output += chunk;
      },
      onStderr: (chunk) => {
        output += chunk;
      },
    },
  );
  broadcast(sessionId, {
    type: "security_upgrade",
    output,
    exitCode: result.exitCode,
    timestamp: Date.now(),
  });
  return c.json({ output, exitCode: result.exitCode });
});

function extractJson(output: string): string {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return start >= 0 && end > start ? output.slice(start, end + 1) : "{}";
}

export default security;
