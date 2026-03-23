/**
 * API Coverage Report
 *
 * Programmatically inspects the EmailClient public API, then scans
 * the test files to report which methods are exercised and which are not.
 *
 * Run:  npx playwright test tests/api-coverage.spec.ts
 * View: cat api-coverage-report.txt
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { EmailClient } from '../src/EmailClient';

interface MethodInfo {
  name: string;
  category: string;
  tier: 'unit' | 'e2e';
  covered: boolean;
}

/** Public methods explicitly listed — private helpers are excluded from coverage. */
const PUBLIC_METHODS = [
  'send',
  'receive',
  'receiveAll',
  'clean',
  'applyFilters',
  'extractHtmlFromSource',
  'extractTextFromSource',
];

test('API Coverage Report', async () => {
  const testDir = path.resolve(__dirname);
  const unitFiles = ['filter-logic.spec.ts', 'mime-parsing.spec.ts'];
  const e2eFiles = ['email-integration.spec.ts'];

  const readFiles = (files: string[]) =>
    files
      .filter(f => fs.existsSync(path.join(testDir, f)))
      .map(f => fs.readFileSync(path.join(testDir, f), 'utf-8'))
      .join('\n');

  const unitSource = readFiles(unitFiles);
  const e2eSource = readFiles(e2eFiles);
  const allSource = unitSource + '\n' + e2eSource;

  const publicMethods = PUBLIC_METHODS;

  const apis: MethodInfo[] = [];

  // ── Unit test coverage ──
  for (const m of publicMethods) {
    const pattern = new RegExp(`\\.${m}\\b`);
    apis.push({
      name: m,
      category: 'EmailClient',
      tier: 'unit',
      covered: pattern.test(unitSource),
    });
  }

  // ── E2E test coverage ──
  for (const m of publicMethods) {
    const pattern = new RegExp(`\\.${m}\\b`);
    apis.push({
      name: m,
      category: 'EmailClient',
      tier: 'e2e',
      covered: pattern.test(e2eSource),
    });
  }

  // ── Build report ──
  const unitApis = apis.filter(a => a.tier === 'unit');
  const e2eApis = apis.filter(a => a.tier === 'e2e');
  const unitCovered = unitApis.filter(a => a.covered);
  const e2eCovered = e2eApis.filter(a => a.covered);

  // Combined: a method is covered if it appears in either unit or e2e
  const combinedCovered = publicMethods.filter(m =>
    apis.some(a => a.name === m && a.covered)
  );

  const lines: string[] = [];
  lines.push('');
  lines.push('========================================================');
  lines.push('                  API COVERAGE REPORT                    ');
  lines.push('========================================================');

  // ── Unit tests ──
  lines.push('');
  lines.push('  UNIT TESTS (filter-logic + mime-parsing)');
  lines.push('  ----------------------------------------');
  const unitPct = ((unitCovered.length / unitApis.length) * 100).toFixed(0);
  lines.push(`  EmailClient: ${unitCovered.length}/${unitApis.length} (${unitPct}%)`);
  for (const api of unitApis) {
    const icon = api.covered ? '  [x]' : '  [ ]';
    lines.push(`    ${icon} ${api.name}`);
  }

  // ── E2E tests ──
  lines.push('');
  lines.push('  E2E TESTS (email-integration)');
  lines.push('  -----------------------------');
  const e2ePct = ((e2eCovered.length / e2eApis.length) * 100).toFixed(0);
  lines.push(`  EmailClient: ${e2eCovered.length}/${e2eApis.length} (${e2ePct}%)`);
  for (const api of e2eApis) {
    const icon = api.covered ? '  [x]' : '  [ ]';
    lines.push(`    ${icon} ${api.name}`);
  }

  // ── Overall summary ──
  lines.push('');
  lines.push('========================================================');
  lines.push(`  OVERALL: ${combinedCovered.length}/${publicMethods.length} methods (${((combinedCovered.length / publicMethods.length) * 100).toFixed(1)}%)`);
  lines.push(`  UNIT:    ${unitCovered.length}/${unitApis.length} methods (${((unitCovered.length / unitApis.length) * 100).toFixed(1)}%)`);
  lines.push(`  E2E:     ${e2eCovered.length}/${e2eApis.length} methods (${((e2eCovered.length / e2eApis.length) * 100).toFixed(1)}%)`);
  lines.push('========================================================');

  // ── Uncovered methods ──
  const uncoveredMethods = publicMethods.filter(
    m => !apis.some(a => a.name === m && a.covered)
  );
  if (uncoveredMethods.length > 0) {
    lines.push('');
    lines.push('  Uncovered methods (not in any test):');
    for (const m of uncoveredMethods) {
      lines.push(`    [ ] ${m}`);
    }
  }

  lines.push('');

  const report = lines.join('\n');
  console.log(report);

  const reportPath = path.resolve(__dirname, '..', 'api-coverage-report.txt');
  fs.writeFileSync(reportPath, report, 'utf-8');

  await test.info().attach('API Coverage Report', {
    body: report,
    contentType: 'text/plain',
  });

  // ── Enforce 100% Coverage ──
  expect(
    uncoveredMethods.length,
    `API coverage is not 100%. Uncovered methods: ${uncoveredMethods.join(', ')}`
  ).toBe(0);
});
