import type { Context, Next } from "hono";
import { verifyToken, type JwtPayload } from "../lib/jwt.js";
import { prisma } from "../db/prisma.js";

declare module "hono" {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) {
      const raw = rest.join("=").trim();
      try {
        result[key.trim()] = decodeURIComponent(raw);
      } catch {
        result[key.trim()] = raw;
      }
    }
  }
  return result;
}

// User existence cache to avoid DB round-trip on every request
const userCache = new Map<string, { exists: boolean; ts: number }>();
const USER_CACHE_TTL = 30_000; // 30 seconds

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  // Extract token — short-circuit when Authorization header is present (skip cookie parsing)
  let token: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else {
    const queryToken = c.req.query("token");
    if (queryToken) {
      token = queryToken;
    } else {
      const cookies = parseCookies(c.req.header("Cookie"));
      token = cookies["agenthub_token"] || null;
    }
  }

  if (!token) {
    return c.json(
      { error: "Missing authorization header or token query param" },
      401,
    );
  }
  try {
    const payload = verifyToken(token);
    // Check user existence cache first to avoid DB hit on every request
    const cached = userCache.get(payload.userId);
    if (cached && Date.now() - cached.ts < USER_CACHE_TTL) {
      if (!cached.exists)
        return c.json(
          { error: "User not found — please re-authenticate" },
          401,
        );
      c.set("user", payload);
      await next();
      return;
    }
    // Cache miss — verify user exists in DB
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true },
    });
    userCache.set(payload.userId, { exists: !!user, ts: Date.now() });
    if (!user) {
      return c.json({ error: "User not found — please re-authenticate" }, 401);
    }
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
