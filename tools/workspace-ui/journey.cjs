// Accepted TWP-9 piece 3. Exercises the real renderer/providers through a fake IPC/Voice SDK.
// The fixture makes no network requests to Twilio, stores no credentials and uses fictional data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8088';
const evidence = process.env.OPERATOR_EVIDENCE_DIR;
if (!evidence)
  throw new Error('Set OPERATOR_EVIDENCE_DIR to a folder outside the project.');
fs.mkdirSync(evidence, { recursive: true });
let browser;
(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    timezoneId: 'Asia/Manila',
  });
  const page = await context.newPage();
  const errors = [],
    results = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => window.__fixture?.device?.state === 'registered',
  );
  const button = (name) => page.getByRole('button', { name, exact: true });
  const nav = (name) =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button')
      .filter({ hasText: new RegExp('^' + name) });
  const shot = async (name) => {
    // Wait for the resized viewport to paint; never publish an intermediate compositor frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `${evidence}/${name}.png` });
  };
  const workspace = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem('fixture-config')).workspace,
    );
  const draft = () => page.getByRole('textbox', { name: /Message draft/ });
  const inbox = (n) => page.locator('.sms-list-item').filter({ hasText: n });
  const check = async (name, fn) => {
    await fn();
    results.push(name);
  };
  await check(
    'Contacts add/edit validation and explicit call confirmation',
    async () => {
      await nav('Contacts').click();
      await button('Add contact').click();
      await page.getByLabel('Name', { exact: true }).fill('Alex Rivera');
      await page
        .getByLabel('Phone number', { exact: true })
        .fill('+1 (202) 555-0101');
      await button('Save contact').click();
      await page.getByRole('article', { name: 'Alex Rivera' }).waitFor();
      await button('Add contact').click();
      await page.getByLabel('Name', { exact: true }).fill('Duplicate Alex');
      await page
        .getByLabel('Phone number', { exact: true })
        .fill('+12025550101');
      await button('Save contact').click();
      await page
        .getByText('This number already belongs to a contact.')
        .waitFor();
      await button('Cancel').click();
      await button('Add contact').click();
      await page.getByLabel('Name', { exact: true }).fill('Morgan Lee');
      await page.getByLabel('Phone number', { exact: true }).fill('2025550102');
      await button('Save contact').click();
      await page.getByText(/Include the country code, for example/).waitFor();
      await page
        .getByLabel('Phone number', { exact: true })
        .fill('+12025550102');
      await button('Save contact').click();
      await page
        .getByRole('article', { name: 'Alex Rivera' })
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
      await page.getByLabel('Name', { exact: true }).fill('Alex R.');
      await button('Save contact').click();
      await page
        .getByRole('article', { name: 'Alex R.' })
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
      await page.getByLabel('Name', { exact: true }).fill('Alex Rivera');
      await button('Save contact').click();
      await page
        .getByRole('searchbox', { name: 'Search contacts' })
        .fill('Alex');
      assert.equal(
        await page.getByRole('article', { name: 'Morgan Lee' }).count(),
        0,
      );
      await page.getByRole('searchbox', { name: 'Search contacts' }).fill('');
      const alex = page.getByRole('article', { name: 'Alex Rivera' });
      await alex.getByRole('button', { name: 'Call', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      assert.match(await page.getByRole('dialog').textContent(), /Alex Rivera/);
      assert.match(
        await page.getByRole('dialog').textContent(),
        /202 555 0101/,
      );
      await button('Cancel').click();
      assert.deepEqual(await page.evaluate(() => window.__fixture.calls), []);
      await shot('after-contacts');
    },
  );
  await check(
    'CSV preview, valid-only import, duplicate skip and cancel without writes',
    async () => {
      await button('Import CSV').click();
      const csvFile =
        'Full name,Mobile\n"Rivera, Alex",+12025550101\n"Jamie ""J"" Chen",+12025550103\nUnclear entry,555';
      await page.getByLabel('CSV file', { exact: true }).setInputFiles({
        name: 'contacts.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvFile),
      });
      await page.waitForFunction(
        (value) =>
          document.querySelector('[aria-label="CSV import review"] textarea')
            ?.value === value,
        csvFile,
      );
      await button('Review rows').click();
      await page
        .getByRole('cell', { name: 'Duplicate · Skip', exact: true })
        .waitFor();
      await page.getByRole('cell', { name: 'New', exact: true }).waitFor();
      await page
        .getByRole('cell', {
          name: 'Invalid · Fix the CSV and review again',
          exact: true,
        })
        .waitFor();
      await shot('after-csv-editor');
      await button('Import 1 new contact').scrollIntoViewIfNeeded();
      await shot('after-csv-review');
      await button('Cancel import').click();
      assert.equal((await workspace()).contacts.length, 2);
      await button('Import CSV').click();
      await page
        .getByLabel('CSV contents')
        .fill(
          'Full name,Mobile\n"Rivera, Alex",+12025550101\nJamie Chen,+12025550103\nUnclear entry,555',
        );
      await button('Review rows').click();
      await button('Import 1 new contact').click();
      await page.getByRole('article', { name: 'Jamie Chen' }).waitFor();
      assert.equal((await workspace()).contacts.length, 3);
      assert.deepEqual(await page.evaluate(() => window.__fixture.calls), []);
    },
  );
  await check(
    'Recipient drafts survive switching, navigation, incoming call and restart',
    async () => {
      await page
        .getByRole('article', { name: 'Alex Rivera' })
        .getByRole('button', { name: 'Text', exact: true })
        .click();
      await draft().fill('Meet at 2?');
      await inbox('Morgan Lee').click();
      assert.equal(await draft().inputValue(), '');
      await draft().fill('Please confirm the address.');
      await nav('Calls').click();
      await nav('Messages').click();
      assert.equal(await draft().inputValue(), 'Please confirm the address.');
      await inbox('Alex Rivera').click();
      assert.equal(await draft().inputValue(), 'Meet at 2?');
      await page.evaluate(() => window.__fixture.incoming('+12025550102'));
      await page
        .getByRole('complementary', { name: 'Incoming call' })
        .waitFor();
      await button('Decline').click();
      assert.equal(await draft().inputValue(), 'Meet at 2?');
      await page.reload();
      await page.waitForFunction(
        () => window.__fixture?.device?.state === 'registered',
      );
      assert.equal(await draft().inputValue(), 'Meet at 2?');
      await inbox('Morgan Lee').click();
      assert.equal(await draft().inputValue(), 'Please confirm the address.');
      await inbox('Alex Rivera').click();
      await shot('after-messages');
    },
  );
  await check(
    'Search jumps to a matching retained message; archive and restore preserve history',
    async () => {
      await page
        .getByRole('searchbox', { name: 'Search messages' })
        .fill('meet at 2 tomorrow');
      await page.locator('.search-result').click();
      await page.locator('.sms-bubble.search-hit').waitFor();
      await shot('after-search');
      await page.getByRole('searchbox', { name: 'Search messages' }).fill('');
      await button('Archive').click();
      await button('Show archived').click();
      await inbox('Alex Rivera').waitFor();
      await shot('after-archive');
      await button('Restore').click();
      await button('Show inbox').click();
      await inbox('Alex Rivera').waitFor();
      assert.match(
        await page.locator('.sms-thread').textContent(),
        /Can we meet at 2 tomorrow/,
      );
    },
  );
  await check(
    'One inbound update creates one unread count and notification, restored after restart',
    async () => {
      await nav('Contacts').click();
      await page.evaluate(() =>
        window.__fixture.inbound(
          '+12025550102',
          'The address is 24 North Street.',
        ),
      );
      await page.waitForFunction(
        () => window.__fixture.notifications.length === 1,
      );
      assert.equal(
        await page.getByLabel('1 unread messages', { exact: true }).count(),
        1,
      );
      await page.reload();
      await page.waitForFunction(
        () => window.__fixture?.device?.state === 'registered',
      );
      await page.getByLabel('1 unread messages', { exact: true }).waitFor();
      assert.equal(
        (await page.evaluate(() => window.__fixture.notifications)).length,
        0,
      );
      await page.evaluate(() => {
        window.__fixture.savedList = window.operator.sms.list;
        window.operator.sms.list = async (opts) =>
          opts?.number
            ? { ok: false, error: 'History is unavailable' }
            : window.__fixture.savedList(opts);
        window.__fixture.notificationClick('+12025550102');
      });
      await page
        .locator('.sms-thread')
        .getByText('History is unavailable', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel('1 unread messages', { exact: true }).count(),
        1,
      );
      await shot('after-history-unavailable');
      await page.evaluate(() => {
        window.operator.sms.list = window.__fixture.savedList;
      });
      await page
        .locator('.sms-thread')
        .getByText('The address is 24 North Street.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel('1 unread messages', { exact: true }).count(),
        0,
      );
    },
  );
  await check(
    'Failed sends retain text; unknown outcomes remain blocked across restart; Enter/Shift+Enter differ',
    async () => {
      await draft().fill('[fail] Please confirm tomorrow’s meeting.');
      await button('Send').click();
      await page
        .getByRole('button', { name: 'Review resend', exact: true })
        .waitFor();
      assert.equal(
        await draft().inputValue(),
        '[fail] Please confirm tomorrow’s meeting.',
      );
      await shot('after-failed');
      await button('Review resend').click();
      await page.getByRole('dialog').waitFor();
      await button('Cancel').click();
      await draft().fill('[unknown] Please confirm tomorrow’s meeting.');
      await draft().press('Shift+Enter');
      assert.match(await draft().inputValue(), /\n/);
      await draft().fill('[unknown] Please confirm tomorrow’s meeting.');
      await draft().press('Enter');
      await page.getByText(/Unknown outcome: “/).waitFor();
      assert.equal(await button('Send').isDisabled(), true);
      await page.reload();
      await page.getByText(/Unknown outcome: “/).waitFor();
      assert.equal(await button('Send').isDisabled(), true);
      await shot('after-unknown');
      // A different message is allowed, but no unknown message has a resend action.
      await draft().fill('Hi Morgan 👋 Please use the north entrance.');
      assert.match(
        await page.locator('.sms-composer-counter').textContent(),
        /Unicode/,
      );
    },
  );
  await check(
    'Calling, mute, DTMF, hangup and persisted app-observed recents',
    async () => {
      await nav('Contacts').click();
      await page
        .getByRole('article', { name: 'Alex Rivera' })
        .getByRole('button', { name: 'Call', exact: true })
        .click();
      await button('Call now').click();
      await page.getByRole('complementary', { name: 'Active call' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.calls), [
        '+12025550101',
      ]);
      await button('Mute').click();
      await button('Unmute').waitFor();
      await page.getByRole('button', { name: 'Send 1', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__fixture.digits), [
        '1',
      ]);
      await button('Hang up').click();
      await nav('Calls').click();
      await button('Recents').click();
      await page.getByText(/outgoing · completed/).waitFor();
      await shot('after-recents');
      await page.reload();
      await nav('Calls').click();
      await button('Recents').click();
      await page.getByText(/outgoing · completed/).waitFor();
      await button('Dialer').click();
      await shot('after-calls');
    },
  );
  await check(
    'Reading position persists across polls, navigation and restart; incoming call stays answerable',
    async () => {
      await nav('Messages').click();
      await inbox('Alex Rivera').click();
      await page.evaluate(() => window.__fixture.addHistory('+12025550101'));
      await page
        .getByText('Meeting notes, item 40: please bring the documents.', {
          exact: true,
        })
        .waitFor();
      await page.locator('.sms-thread').evaluate((el) => {
        el.scrollTop = 120;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await nav('Contacts').click();
      await nav('Messages').click();
      assert.equal(
        await page.locator('.sms-thread').evaluate((el) => el.scrollTop),
        120,
      );
      await page.reload();
      await page
        .getByText('Meeting notes, item 40: please bring the documents.', {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.locator('.sms-thread').evaluate((el) => el.scrollTop),
        120,
      );
      await page.evaluate(() => window.__fixture.incoming('+12025550102'));
      await page
        .getByRole('complementary', { name: 'Incoming call' })
        .waitFor();
      await shot('after-incoming-call');
      await button('Decline').click();
      assert.equal(
        await page.locator('.sms-thread').evaluate((el) => el.scrollTop),
        120,
      );
    },
  );
  await check(
    'Narrow list/detail navigation, confirmed clearing and contact removal preserve other data',
    async () => {
      await page.setViewportSize({ width: 480, height: 800 });
      await button('Back to conversations').click();
      await inbox('Alex Rivera').waitFor();
      await shot('after-narrow-list');
      await inbox('Alex Rivera').click();
      await draft().waitFor();
      const composer = await page.locator('.sms-composer').boundingBox();
      assert.ok(
        composer.y + composer.height <= 800,
        'The narrow composer must stay inside the visible window with long history.',
      );
      await shot('after-narrow-thread');
      await page.setViewportSize({ width: 480, height: 560 });
      const smallComposer = await page.locator('.sms-composer').boundingBox();
      assert.ok(
        smallComposer.y + smallComposer.height <= 560,
        'The composer must remain reachable at the minimum window size.',
      );
      await shot('after-narrow-minimum');
      await page.setViewportSize({ width: 480, height: 800 });
      await page
        .getByRole('button', { name: 'Clear messages in this thread' })
        .click();
      await page
        .locator('.sms-thread-clear-prompt')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      assert.equal((await page.locator('.sms-bubble').count()) > 0, true);
      await page
        .getByRole('button', { name: 'Clear messages in this thread' })
        .click();
      await page
        .locator('.sms-thread-clear-prompt')
        .getByRole('button', { name: 'Clear', exact: true })
        .click();
      await page
        .getByText('No messages yet. Type below to start the conversation.')
        .waitFor();
      assert.equal(await draft().inputValue(), 'Meet at 2?');
      await nav('Contacts').click();
      await page
        .getByRole('article', { name: 'Morgan Lee' })
        .getByRole('button', { name: 'Remove', exact: true })
        .click();
      await button('Remove contact').click();
      await nav('Messages').click();
      assert.equal(await draft().inputValue(), 'Meet at 2?');
      await button('Back to conversations').click();
      await inbox('0102').click();
      await page
        .getByText('The address is 24 North Street.', { exact: true })
        .waitFor();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  );
  await check(
    'Manual contact queue: ordering, deduplication, one press per call, review, interruptions and restart',
    async () => {
      const calls = () => page.evaluate(() => window.__fixture.calls);
      const queueRows = () => page.locator('.queue-list > li');
      const rowNames = async () =>
        (await queueRows().locator('strong').allTextContents());
      const queueTab = () => page.locator('.calls-page .subnav button').filter({ hasText: /^Queue/ });
      const callNext = () => page.getByRole('button', { name: /^Call next/ });
      const dialog = () => page.getByRole('dialog', { name: 'Confirm call destination' });
      const addContact = async (name, number) => {
        await button('Add contact').click();
        await page.getByLabel('Name', { exact: true }).fill(name);
        await page.getByLabel('Phone number', { exact: true }).fill(number);
        await button('Save contact').click();
        await page.getByRole('article', { name }).waitFor();
      };
      const card = (name) => page.getByRole('article', { name });
      await page.setViewportSize({ width: 1280, height: 800 });
      await nav('Contacts').click();
      await addContact('Jamie Chen', '+12025550103');
      await addContact('Sam Patel', '+12025550104');
      // Select two contacts, then add a third on its own: one queue, in that order.
      await page.getByLabel('Select Alex Rivera').check();
      await page.getByLabel('Select Jamie Chen').check();
      await button('Queue selected (2)').click();
      await page.getByText(/2 contacts added to the queue/).waitFor();
      await card('Sam Patel').getByRole('button', { name: 'Add Sam Patel to queue' }).click();
      await card('Alex Rivera').getByRole('button', { name: 'Add Alex Rivera to queue' }).click();
      await page.getByText(/Alex Rivera is already in the queue/).waitFor();
      assert.deepEqual(await calls(), [], 'Adding contacts never dials.');
      // A thread can be queued too (this number is not a contact).
      await nav('Messages').click();
      await inbox('0102').click();
      await button('Add to queue').click();
      await page.getByText(/added to the queue/).waitFor();
      // Calls → Queue: ordering and deduplication.
      await nav('Calls').click();
      await queueTab().click();
      assert.deepEqual(await rowNames(), ['Alex Rivera', 'Jamie Chen', 'Sam Patel', '+1 202 555 0102'].map((n) => n));
      await page.getByRole('button', { name: 'Move Sam Patel up' }).click();
      assert.deepEqual((await rowNames()).slice(0, 3), ['Alex Rivera', 'Sam Patel', 'Jamie Chen']);
      await shot('queue-ordered');
      await page.reload();
      await nav('Calls').click();
      await queueTab().click();
      assert.deepEqual((await rowNames()).slice(0, 3), ['Alex Rivera', 'Sam Patel', 'Jamie Chen']);
      // Edit Jamie after queueing: a stale destination needs review.
      await nav('Contacts').click();
      await card('Jamie Chen').getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByLabel('Phone number', { exact: true }).fill('+12025550133');
      await button('Save contact').click();
      await nav('Calls').click();
      await page.getByText(/changed after it was queued/).waitFor();
      await shot('queue-review');
      // One press dials exactly the visible contact, with no second dialog,
      // and a double click makes one call.
      await callNext().dblclick();
      await page.getByRole('complementary', { name: 'Active call' }).waitFor();
      assert.deepEqual(await calls(), ['+12025550101']);
      assert.equal(await page.locator('.queue-outcomes li').count(), 0, 'The double press did not end the call.');
      assert.equal(await dialog().count(), 0);
      assert.equal(await callNext().count(), 0, 'No second Call next while a call is active.');
      await shot('queue-active');
      // The far end hangs up: the outcome is recorded and nobody is dialed.
      await page.evaluate(() => window.__fixture.activeCall.disconnect());
      await page.getByText(/Completed/).first().waitFor();
      assert.deepEqual(await calls(), ['+12025550101']);
      assert.equal(await callNext().isEnabled(), true);
      assert.match(await callNext().getAttribute('aria-label'), /Sam Patel/);
      // An incoming call blocks dialing and keeps every pending contact.
      await page.evaluate(() => window.__fixture.incoming('+12025550102'));
      await page.getByRole('complementary', { name: 'Incoming call' }).waitFor();
      assert.equal(await callNext().isDisabled(), true);
      await button('Decline').click();
      await callNext().waitFor();
      assert.equal(await callNext().isEnabled(), true);
      assert.deepEqual(await rowNames(), ['Sam Patel', 'Jamie Chen', '+1 202 555 0102']);
      // Sam is called, then hung up from the queue; Jamie must be reviewed first.
      await callNext().click();
      await page.getByRole('complementary', { name: 'Active call' }).getByRole('button', { name: 'Hang up' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.queue-outcomes li').length === 2);
      assert.deepEqual(await calls(), ['+12025550101', '+12025550104']);
      assert.equal(await callNext().isDisabled(), true);
      await button('Use current details').click();
      await callNext().click();
      await page.getByRole('complementary', { name: 'Active call' }).waitFor();
      assert.deepEqual(await calls(), ['+12025550101', '+12025550104', '+12025550133']);
      // The app restarts during the call: nothing resumes or redials.
      await page.reload();
      await page.waitForFunction(() => window.__fixture?.device?.state === 'registered');
      await nav('Calls').click();
      await queueTab().click();
      await page.getByText(/Interrupted: the app closed during this call/).waitFor();
      assert.deepEqual(await rowNames(), ['+1 202 555 0102']);
      assert.deepEqual(await calls(), [], 'Reopening never calls anyone.');
      await shot('queue-after-restart');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-config')).workspace.drafts['+12025550101']), 'Meet at 2?');
    },
  );
  await nav('Settings').click();
  await shot('after-settings');
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    `${evidence}/workspace-journey.json`,
    JSON.stringify(
      {
        url,
        results,
        consoleErrors: errors,
        scope:
          'Real renderer and providers; fake SDK and IPC only, no live account operations.',
      },
      null,
      2,
    ),
  );
  console.log(results.map((r, i) => `${i + 1}. ${r}`).join('\n'));
  await browser.close();
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exitCode = 1;
});
