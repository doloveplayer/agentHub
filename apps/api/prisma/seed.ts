import { PrismaClient } from '@prisma/client';
import { defaultAgents } from '../src/defaultAgents.js';

const prisma = new PrismaClient();

async function main() {
  console.log('[seed] Seeding default agents...');
  for (const agent of defaultAgents) {
    await prisma.agent.upsert({
      where: { name: agent.name },
      update: agent,
      create: agent,
    });
    console.log(`[seed] Upserted agent: ${agent.name}`);
  }
  console.log('[seed] Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
