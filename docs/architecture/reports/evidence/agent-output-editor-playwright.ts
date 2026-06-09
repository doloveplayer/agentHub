import { chromium, type Locator } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'http://127.0.0.1:3000';
const WEB = 'http://127.0.0.1:5175';
const ROOT = process.cwd();

async function api(path: string, token?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  if (!(init.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return body;
}

async function expectVisible(locator: Locator, timeout = 10_000) {
  await locator.waitFor({ state: 'visible', timeout });
}

async function expectHidden(locator: Locator, timeout = 10_000) {
  await locator.waitFor({ state: 'hidden', timeout });
}

async function pollUntil<T>(fn: () => T, expected: T, timeout = 5_000) {
  const started = Date.now();
  let last: T;
  do {
    last = fn();
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() - started < timeout);
  throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
}

async function main() {
  const dev = await api('/api/auth/dev-token');
  const token = dev.token as string;
  const session = await api('/api/sessions', token, {
    method: 'POST',
    body: JSON.stringify({ type: 'solo' }),
  });
  const sessionId = session.id as string;
  const title = `Output Editor PW ${Date.now()}`;
  await api(`/api/sessions/${sessionId}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });

  const sandbox = resolve(ROOT, '.sandboxes', sessionId);
  mkdirSync(resolve(sandbox, 'docs', 'nested'), { recursive: true });
  writeFileSync(resolve(sandbox, 'docs', 'report.md'), '# Original\n');
  writeFileSync(resolve(sandbox, 'docs', 'nested', 'note.txt'), 'nested');
  writeFileSync(resolve(sandbox, 'deck.pptx'), Buffer.from('pptx-binary-placeholder'));

  const browser = await chromium.launch({ headless: true, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 920 } });
  page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));

  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('agenthub_token', value), token);
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.getByText(title).click();
  await page.getByText('Files').first().click();
  const fileTree = page.locator('.font-mono').first();
  const reportFile = fileTree.getByText('report.md', { exact: true });
  await expectVisible(reportFile);

  const folderDownloadPromise = page.waitForEvent('download');
  await page.locator('button[title="Download folder"]').first().click();
  const folderDownload = await folderDownloadPromise;
  console.log(`folder_download=${folderDownload.suggestedFilename()}`);
  if (!folderDownload.suggestedFilename().endsWith('.zip')) {
    throw new Error(`Expected folder download to be .zip, got ${folderDownload.suggestedFilename()}`);
  }

  await reportFile.click();
  await expectVisible(page.getByTestId('workspace-editor-inline'));
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('# Edited from Playwright\n');
  await page.locator('button[title="Save"]').first().click();
  await pollUntil(() => readFileSync(resolve(sandbox, 'docs', 'report.md'), 'utf-8'), '# Edited from Playwright\n');

  await reportFile.dblclick();
  const fullscreen = page.getByTestId('workspace-editor-fullscreen');
  await expectVisible(fullscreen);
  const box = await fullscreen.boundingBox();
  console.log(`fullscreen_box=${box?.width}x${box?.height}`);
  if (!box || box.width < 900 || box.height < 700) {
    throw new Error(`Fullscreen editor too small: ${JSON.stringify(box)}`);
  }
  await fullscreen.locator('button[title="Exit fullscreen"]').click();
  await expectHidden(fullscreen);

  await fileTree.getByText('deck.pptx', { exact: true }).click();
  await expectVisible(page.getByText('Binary artifact'));
  const pptDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('workspace-editor-inline').locator('button[title="Download file"]').click();
  const pptDownload = await pptDownloadPromise;
  console.log(`ppt_download=${pptDownload.suggestedFilename()}`);
  if (pptDownload.suggestedFilename() !== 'deck.pptx') {
    throw new Error(`Expected deck.pptx download, got ${pptDownload.suggestedFilename()}`);
  }

  await browser.close();
  await api(`/api/sessions/${sessionId}`, token, { method: 'DELETE' });
  rmSync(sandbox, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
