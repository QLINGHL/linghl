const fs = require('node:fs');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const browser = await (pw.default ?? pw).chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('main_window'));
  assert.ok(page, 'Replica renderer not found');
  const out = 'artifacts/flow-observation/upstream-desktop';
  fs.mkdirSync(out, {recursive:true});
  const scale = await page.evaluate(() => devicePixelRatio);
  const hwnd = process.env.FLOW_HWND || '2492254';
  async function desktopClick(locator, name) {
    await locator.scrollIntoViewIfNeeded();
    const rect = await locator.boundingBox();
    assert.ok(rect);
    execFileSync('python', ['tools/ui-flow-desktop.py', hwnd, out+'/'+name+'.png',
      '--click', String(Math.round((rect.x+Math.min(rect.width/2,160))*scale)),
      String(Math.round((rect.y+rect.height/2)*scale)), '--wait','0.7'], {encoding:'utf8'});
  }
  const history = () => page.locator('button[title]').filter({hasText:'这是界面流程验证。先用一句话说明即将执行的步骤'}).first();
  await desktopClick(history(), '01-history');
  await page.locator('.flow-work-header button').waitFor();
  const duration = await page.locator('.flow-work-header').innerText();
  if(await page.locator('.flow-work-header button').getAttribute('aria-expanded')!=='true') await desktopClick(page.locator('.flow-work-header button'), '02-work-open');
  const title = page.getByRole('button', {name:'Planning stepwise terminal commands',exact:true});
  assert.equal(await title.count(),1,'Upstream parser must remove Markdown from reasoning title');
  assert.equal(await page.getByRole('button',{name:'Ran a command',exact:true}).count(),0,'Single command has a redundant group');
  const command = page.locator('.flow-cluster button').filter({hasText:/^Ran Get-Location/}).first();
  if(await page.locator('.flow-shell').count()===0) await desktopClick(command, '04-shell-open');
  const shellText = await page.locator('.flow-shell').first().innerText();
  assert.ok(shellText.includes('Shell') && shellText.includes('Success'));
  assert.equal(await page.locator('.katex-error').count(),0);
  const width=await page.locator('.katex .fbox').first().evaluate(e=>e.getBoundingClientRect().width);
  assert.ok(width>10, 'The one-digit boxed formula must have a visible border');
  execFileSync('python',['tools/ui-flow-desktop.py',hwnd,out+'/05-reload.png','--keys','^r','--wait','1.3'],{encoding:'utf8'});
  await desktopClick(history(),'06-restored-history');
  await page.locator('.flow-work-header button').waitFor();
  assert.equal(await page.locator('.flow-work-header').innerText(),duration,'Work duration changed on history reload');
  await desktopClick(page.locator('.flow-work-header button'),'07-restored-disclosures');
  assert.ok(await page.locator('.flow-shell').count()>=1,'Shell expansion was lost after reload');
  const result={passed:true,duration,boxedWidth:width,mathErrors:0,reasoningTitle:await title.innerText(),
    singleToolDirect:true,persistedShell:true,modelCalls:0,timestamp:new Date().toISOString()};
  fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
