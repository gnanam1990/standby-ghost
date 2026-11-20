import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSV = readFileSync(path.join(root, 'fixtures/the-returning-letter.csv'), 'utf8');

// Release regression: the production page once bound export-link and
// room-create twice (inside prod-create AND at module scope), so one click
// fired two requests — and a new production never opened for import.
test('one click acts once; new production opens ready for import', async ({ page }) => {
  const roomPosts = [];
  const exportGets = [];
  const downloads = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && /\/api\/productions\/[^/]+\/rooms$/.test(p)) roomPosts.push(r);
    if (r.method() === 'GET' && /\/export\.csv$/.test(p)) exportGets.push(r);
  });
  page.on('download', (d) => downloads.push(d));

  await page.goto('/');
  await page.fill('#prod-name', 'Browser Release Prod');
  await page.click('#prod-create');

  // creating a production must open it, ready for import
  await expect(page.locator('#import-section')).toBeVisible();
  await expect(page.locator('#import-prod-name')).toHaveText('Browser Release Prod');

  await page.fill('#csv-text', CSV);
  await page.click('#csv-import');
  await expect(page.locator('#preview-section')).toBeVisible();
  await expect(page.locator('#preview-meta')).toContainText('cues');

  // exactly one room per click
  await page.click('#room-create');
  await expect(page.locator('#room-status')).toContainText('Room ready');
  await page.waitForTimeout(400);
  expect(roomPosts).toHaveLength(1);

  // exactly one export fetch and one download per click
  await page.click('#export-link');
  await page.waitForTimeout(600);
  expect(exportGets).toHaveLength(1);
  expect(downloads).toHaveLength(1);
});
