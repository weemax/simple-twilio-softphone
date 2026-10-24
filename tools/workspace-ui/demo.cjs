// Real-speed persistence demonstration; short pauses are for viewers, not retrying tests.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
(async () => {
  const dir = process.env.OPERATOR_EVIDENCE_DIR;
  if (!dir) throw new Error('Set OPERATOR_EVIDENCE_DIR outside the project.');
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Manila',
    recordVideo: { dir, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  await page.goto(process.argv[2] || 'http://127.0.0.1:8089');
  await page.waitForFunction(
    () => window.__fixture?.device?.state === 'registered',
  );
  const input = page.getByRole('textbox', { name: /Message draft/ });
  await input.fill('Meet at 2?');
  await page.waitForTimeout(1800);
  await page.locator('.sms-list-item').filter({ hasText: '0102' }).click();
  assert.equal(await input.inputValue(), '');
  await input.fill('Please confirm the address.');
  await page.waitForTimeout(1800);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Calls', exact: true })
    .click();
  await page.waitForTimeout(1400);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Messages', exact: true })
    .click();
  await page.waitForTimeout(1800);
  assert.equal(await input.inputValue(), 'Please confirm the address.');
  fs.writeFileSync(
    path.join(dir, 'after-drafts.json'),
    JSON.stringify(
      {
        recipientSwitchDraft: '',
        afterNavigationDraft: await input.inputValue(),
        providerCalls: await page.evaluate(() => window.__fixture.calls),
      },
      null,
      2,
    ),
  );
  const video = page.video();
  await ctx.close();
  await video.saveAs(path.join(dir, 'after-drafts.webm'));
  await browser.close();
})();
