/**
 * Entry point for `npm run eval`.
 *
 * The harness itself does the measuring and writes results.json. The single
 * assertion here is deliberately not about the numbers: it checks the run
 * completed and produced a file. A harness whose numbers could fail the build
 * is a harness someone will eventually be tempted to adjust.
 */
import { it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

it('runs the evaluation and writes results.json', async () => {
  await import('./run-eval');
  const path = resolve(__dirname, 'results.json');
  expect(existsSync(path)).toBe(true);

  const results = JSON.parse(readFileSync(path, 'utf8'));
  // The conditions must always be recorded. A number without them invites
  // the one question that cannot be answered on stage.
  expect(results.environment.machine).toBeTruthy();
  expect(results.environment).toHaveProperty('weightsPresent');
  // Rows that did not run must say so rather than reporting zero.
  expect(Array.isArray(results.notRun)).toBe(true);
});
