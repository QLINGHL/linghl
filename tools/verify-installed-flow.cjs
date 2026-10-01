const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const browser = await (pw.default ?? pw).chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    const page = browser.contexts()[0].pages().find(p => p.url().includes('/.vite/renderer/main_window/'));
    assert.ok(page, 'Must be the built renderer in the user project');
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const history = () => page.locator('button[title]').filter({hasText:'这是界面流程验证。先用一句话说明即将执行的步骤'}).first();
    await history().waitFor({ timeout: 20000 }); await history().click();
    await page.locator('[data-conversation-renderer="project-react"]').waitFor();
    await page.locator('.flow-work-header button').waitFor();
    const duration = await page.locator('.flow-work-header').innerText();
    if (await page.locator('.flow-work-header button').getAttribute('aria-expanded') !== 'true') await page.locator('.flow-work-header button').click();
    const title = page.getByRole('button', { name: 'Planning stepwise terminal commands', exact: true });
    assert.equal(await title.count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Ran a command', exact: true }).count(), 0);
    if (await page.locator('.flow-shell').count() === 0) await page.locator('.flow-cluster button').filter({ hasText: /^Ran Get-Location/ }).first().click();
    const body = await page.locator('.flow-shell').first().innerText(); assert.match(body, /Shell/); assert.match(body, /Success/);
    const font = await page.locator('.prose-chat').first().evaluate(e => getComputedStyle(e).fontSize); assert.equal(font, '14px');
    assert.equal(await page.locator('.katex-error').count(), 0);
    assert.ok(await page.locator('.katex .fbox').first().evaluate(e => e.getBoundingClientRect().width > 10));
    const beforeIds = await page.locator('[data-activity-id]').evaluateAll(nodes => nodes.map(n => n.dataset.activityId));
    await page.reload(); await history().waitFor({ timeout: 20000 }); await history().click();
    await page.locator('.flow-work-header button').waitFor();
    assert.equal(await page.locator('.flow-work-header').innerText(), duration);
    await page.locator('.flow-work-header button').click();
    assert.ok(await page.locator('.flow-shell').count() >= 1);
    assert.deepEqual(await page.locator('[data-activity-id]').evaluateAll(nodes => nodes.map(n => n.dataset.activityId)), beforeIds);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.getByRole('button', { name: '中断', exact: true }).count(), 0);
    const health = await page.evaluate(async () => {
      const result = await window.codex.request('thread/list', { limit: 1 });
      return { historyReadable: Array.isArray(result.data), userData: (await window.codex.appInfo()).userData };
    });
    assert.equal(health.historyReadable, true); assert.match(health.userData, /codex-desk-replica/);
    assert.deepEqual(errors, []);
    // Leave the compact completed conversation ready for the single final capture.
    await page.locator('.flow-work-header button').click();
    await page.locator('.flow-scroll').evaluate(e => { e.scrollTop = 0; });
    const result = { passed: true, projectUrl: page.url(), bundle: await page.locator('script[type="module"]').getAttribute('src'), duration, font, health, orderedActivityIds: beforeIds, persistedShell: true, pageErrors: errors, modelCalls: 0, screenshots: 0, timestamp: new Date().toISOString() };
    fs.mkdirSync('artifacts/flow-observation/installed', { recursive: true });
    fs.writeFileSync('artifacts/flow-observation/installed/results.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
