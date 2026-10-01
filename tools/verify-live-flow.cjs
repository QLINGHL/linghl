const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const browser = await (pw.default ?? pw).chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('main_window'));
  if (!page) throw new Error('Replica renderer not found');
  const out = process.env.FLOW_CAPTURE_DIR || 'artifacts/flow-observation/live-' + new Date().toISOString().replace(/[:.]/g, '-');
  const hwnd = process.env.FLOW_HWND || '2492254';
  fs.mkdirSync(out, {recursive:true});
  await page.evaluate(() => {
    window.flowEvents = [];
    window.codex.onNotification(n => {
      if (/^(turn\/|item\/|error)/.test(n.method)) {
        const p = n.params, i = p.item;
        window.flowEvents.push({ method:n.method, time:Date.now(), threadId:p.threadId, turnId:p.turnId,
          type:i?.type, id:i?.id, phase:i?.phase, status:i?.status ?? p.turn?.status });
      }
    });
  });
  await page.getByRole('button', {name:'新聊天',exact:true}).click();
  const input = page.getByRole('textbox', {name:'消息输入框'});
  const rect = await input.boundingBox();
  const scale = await page.evaluate(() => devicePixelRatio);
  fs.writeFileSync(out+'/composer.json',JSON.stringify({rect,scale}));
  console.log('COMPOSER',JSON.stringify({rect,scale}));
  // User input goes through the desktop keyboard; DOM reading only records state.
  execFileSync('python',['tools/ui-flow-desktop.py',hwnd,out+'/00-before.png','--click',String(Math.round((rect.x+60)*scale)),String(Math.round((rect.y+20)*scale)),
    '--text-file','artifacts/flow-observation/short-flow-prompt.txt','--keys','{ENTER}','--wait','0.2'],{encoding:'utf8'});
  const timeline=[];
  for(let i=0;i<55;i++) {
    const state=await page.evaluate(()=>({
      time:Date.now(), header:[...document.querySelectorAll('.flow-work-header')].map(e=>e.innerText),
      activity:document.querySelector('.flow-activity')?.innerText,
      thinking:document.querySelector('.flow-live-status')?.innerText,
      working:!!document.querySelector('[data-turn-status="working"]'),
      finalActions:document.querySelectorAll('button[aria-label="复制回复"]').length,
      errors:document.querySelectorAll('.katex-error').length,
      events:window.flowEvents
    }));
    timeline.push({...state,events:undefined});
    fs.writeFileSync(out+'/events.json',JSON.stringify(state.events,null,2));
    fs.writeFileSync(out+'/timeline.json',JSON.stringify(timeline,null,2));
    execFileSync('python',['tools/ui-flow-desktop.py',hwnd,out+'/frame-'+String(i).padStart(3,'0')+'.png','--wait','0.1'],{encoding:'utf8'});
    console.log(JSON.stringify({...state,events:state.events.length,activity:state.activity?.slice(0,140)}));
    if(state.finalActions>0&&!state.working) break;
    await page.waitForTimeout(2000);
  }
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
