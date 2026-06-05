import Docker from "dockerode";
import { prisma } from "../db/prisma.js";
import { config } from "../config.js";

const docker = new Docker({ socketPath: config.sandbox.hostDockerSocket });

export async function getSessionContainer(
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId || !session.sandboxContainerId)
    return null;
  try {
    await docker.getContainer(session.sandboxContainerId).inspect();
  } catch {
    return null;
  }
  return session.sandboxContainerId;
}
