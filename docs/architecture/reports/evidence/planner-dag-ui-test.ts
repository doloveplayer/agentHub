import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { prisma } from '../../../../apps/api/src/db/prisma.ts';
import { signToken } from '../../../../apps/api/src/lib/jwt.ts';

const BASE = 'http://127.0.0.1:5173';
const PLAN_SHOT = resolve('docs/superpowers/reports/evidence/planner-dag-ui-plan.png');
const DONE_SHOT = resolve('docs/superpowers/reports/evidence/planner-dag-ui-done.png');
const OUT = resolve('docs/superpowers/reports/evidence/planner-dag-ui-evidence.json');

async function main() {
  const user = await prisma.user.upsert({
    where: { githubId: 990026 },
    update: { login: 'dag-ui-user', avatarUrl: 'https://example.com/dag-ui.png', email: 'dag-ui@example.com' },
    create: { githubId: 990026, login: 'dag-ui-user', avatarUrl: 'https://example.com/dag-ui.png', email: 'dag-ui@example.com' },
  });
  const token = signToken({ userId: user.id, githubLogin: user.login });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const events: string[] = [];
  page.on('console', (msg) => events.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => events.push(`[pageerror] ${err.message}`));

  try {
    await page.addInitScript((value) => {
      const OriginalWebSocket = window.WebSocket;
      (window as any).__agenthubWsMessages = [];
      window.WebSocket = class extends OriginalWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('message', (event) => {
            (window as any).__agenthubWsMessages.push(String(event.data));
          });
        }
      };
      window.localStorage.setItem('agenthub_token', value);
    }, token);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sessions' }).waitFor({ timeout: 10_000 });

    await page.locator('button[title="New Session"]').click();
    await page.getByRole('button', { name: /Group Session/ }).click();
    await page.getByText('Participants').waitFor({ timeout: 10_000 });

    const input = page.locator('textarea[placeholder^="Type a message"]').first();
    await input.fill('/plan Planner DAG UI smoke');
    await input.press('Enter');

    try {
      await page.getByText('Review Task Plan').waitFor({ timeout: 20_000 });
    } catch (err) {
      await page.screenshot({ path: resolve('docs/superpowers/reports/evidence/planner-dag-ui-debug.png'), fullPage: true });
      console.error(await page.locator('body').innerText().catch(() => '<no body text>'));
      console.error(events.join('\n'));
      console.error(await page.evaluate(() => (window as any).__agenthubWsMessages?.join('\n') || '<no ws messages>'));
      throw err;
    }
    await page.getByText('Tasks', { exact: true }).click();
    await page.getByText('Active Plan').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: PLAN_SHOT, fullPage: true });

    await page.getByRole('button', { name: /Confirm All/ }).click();
    const allow = page.getByRole('button', { name: 'Allow' });
    if (await allow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await allow.click();
    }

    await page.getByText(/2\/2 done/).waitFor({ timeout: 20_000 });
    await page.getByText('Plan Summary').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: DONE_SHOT, fullPage: true });

    const bodyText = await page.locator('body').innerText();
    assert.match(bodyText, /2\/2 done/);
    assert.match(bodyText, /Plan Summary/);

    const evidence = {
      createdAt: new Date().toISOString(),
      provider: 'test',
      deploymentScope: 'excluded by request',
      screenshots: {
        plan: 'evidence/planner-dag-ui-plan.png',
        done: 'evidence/planner-dag-ui-done.png',
      },
      assertions: {
        reviewPanelVisible: true,
        tasksTabActivePlanVisible: true,
        confirmAllClicked: true,
        completedTwoOfTwo: true,
        planSummaryVisible: true,
      },
      console: events,
    };
    writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, evidence: OUT, screenshots: [PLAN_SHOT, DONE_SHOT] }, null, 2));
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
