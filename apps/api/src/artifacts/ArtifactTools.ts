export interface DeploymentFiles {
  dockerfile: string;
  compose: string;
  envExample: string;
}

export interface DeploymentFileInput {
  appName: string;
  buildCommand?: string;
  startCommand?: string;
  env?: string[];
}

export interface TestCaseResult {
  name: string;
  status: 'passed' | 'failed';
  durationMs?: number;
  error?: string;
}

export interface TestReport {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: TestCaseResult[];
  raw: string;
}

export interface AuditFinding {
  packageName: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'info';
  title: string;
  url?: string;
  cves: string[];
  range?: string;
  fixAvailable: boolean;
}

export interface SecurityReport {
  total: number;
  bySeverity: Record<AuditFinding['severity'], AuditFinding[]>;
  raw?: unknown;
}

export interface ReviewFinding {
  id: string;
  severity: 'high' | 'warning' | 'suggestion';
  file: string;
  line: number;
  message: string;
  status: 'open' | 'fixed' | 'ignored';
}

export interface ReviewReport {
  findings: ReviewFinding[];
}

export function buildDeploymentFiles(input: DeploymentFileInput): DeploymentFiles {
  const appName = sanitizeName(input.appName || 'agenthub-app');
  const buildCommand = input.buildCommand || 'npm run build';
  const startCommand = input.startCommand || 'npm start';
  const env = [...new Set(input.env ?? [])].filter(Boolean);
  return {
    dockerfile: [
      'FROM node:22-alpine AS deps',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      '',
      'FROM node:22-alpine AS build',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci',
      'COPY . .',
      `RUN ${buildCommand}`,
      '',
      'FROM node:22-alpine AS runtime',
      'WORKDIR /app',
      'ENV NODE_ENV=production',
      'COPY --from=deps /app/node_modules ./node_modules',
      'COPY --from=build /app .',
      'EXPOSE 3000',
      `CMD ${JSON.stringify(['sh', '-lc', startCommand])}`,
      '',
    ].join('\n'),
    compose: [
      'services:',
      `  ${appName}:`,
      '    build: .',
      '    env_file:',
      '      - .env',
      '    ports:',
      '      - "3000:3000"',
      '    restart: unless-stopped',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/ || exit 1"]',
      '      interval: 30s',
      '      timeout: 5s',
      '      retries: 3',
      '',
    ].join('\n'),
    envExample: `${env.map((name) => `${name}=`).join('\n')}${env.length ? '\n' : ''}`,
  };
}

export function parseTestOutput(raw: string): TestReport {
  const cases: TestCaseResult[] = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^(PASS|FAIL)\s+(.+)$/);
    if (match) {
      cases.push({
        name: match[2].trim(),
        status: match[1] === 'PASS' ? 'passed' : 'failed',
      });
    }
  }

  const summary = raw.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/i);
  const failed = summary?.[1] ? Number(summary[1]) : cases.filter((item) => item.status === 'failed').length;
  const passed = summary?.[2] ? Number(summary[2]) : cases.filter((item) => item.status === 'passed').length;
  const total = summary?.[3] ? Number(summary[3]) : Math.max(cases.length, passed + failed);
  const time = raw.match(/Time:\s*([\d.]+)\s*s/i);
  const durationMs = time ? Math.round(Number(time[1]) * 1000) : 0;

  for (const item of cases.filter((entry) => entry.status === 'failed')) {
    const idx = raw.indexOf(`FAIL ${item.name}`);
    item.error = idx >= 0 ? raw.slice(idx, idx + 800).trim() : undefined;
  }

  return { total, passed, failed, durationMs, cases, raw };
}

export function parseNpmAuditJson(raw: string): SecurityReport {
  const parsed = JSON.parse(raw || '{}');
  const bySeverity: SecurityReport['bySeverity'] = {
    critical: [],
    high: [],
    moderate: [],
    low: [],
    info: [],
  };
  const vulnerabilities = parsed.vulnerabilities ?? {};
  for (const [packageName, vuln] of Object.entries<any>(vulnerabilities)) {
    const severity = normalizeSeverity(vuln.severity);
    const advisories = Array.isArray(vuln.via) ? vuln.via.filter((item: unknown) => typeof item === 'object' && item) : [];
    const cves: string[] = advisories.flatMap((item: any) => {
      const values = [item.cve, item.source, item.url, item.title].filter(Boolean).map(String);
      return values.flatMap((value) => value.match(/CVE-\d{4}-\d+/g) ?? []);
    });
    bySeverity[severity].push({
      packageName,
      severity,
      title: advisories[0]?.title || vuln.name || packageName,
      url: advisories[0]?.url,
      cves: [...new Set(cves)],
      range: vuln.range,
      fixAvailable: Boolean(vuln.fixAvailable),
    });
  }
  const total = Object.values(bySeverity).reduce((sum, items) => sum + items.length, 0);
  return { total, bySeverity, raw: parsed };
}

export function parseReviewReport(raw: string): ReviewReport {
  const findings: ReviewFinding[] = [];
  const pattern = /^(HIGH|WARNING|WARN|SUGGESTION|SUGGEST)\s+(.+?):(\d+)\s+(.+)$/i;
  for (const line of raw.split('\n')) {
    const match = line.trim().match(pattern);
    if (!match) continue;
    const severity = normalizeReviewSeverity(match[1]);
    findings.push({
      id: `review-${findings.length + 1}`,
      severity,
      file: match[2],
      line: Number(match[3]),
      message: match[4],
      status: 'open',
    });
  }
  return { findings };
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agenthub-app';
}

function normalizeSeverity(value: unknown): AuditFinding['severity'] {
  if (value === 'critical' || value === 'high' || value === 'moderate' || value === 'low' || value === 'info') return value;
  return 'low';
}

function normalizeReviewSeverity(value: string): ReviewFinding['severity'] {
  const normalized = value.toLowerCase();
  if (normalized === 'high') return 'high';
  if (normalized.startsWith('warn')) return 'warning';
  return 'suggestion';
}
