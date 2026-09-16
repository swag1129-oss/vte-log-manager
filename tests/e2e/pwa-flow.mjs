// Headless Chrome walk-through of the PWA against a fake Dropbox (see tests/e2e/README.md).
import {spawn} from "node:child_process"; import fs from "node:fs";
const proc = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new","--remote-debugging-port=9335","--user-data-dir=/tmp/pwa-e2e-run/profile3","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let t; for(let i=0;i<50;i++){try{t=await(await fetch("http://127.0.0.1:9335/json")).json();break}catch{await sleep(200)}}
const ws=new WebSocket(t.find(x=>x.type==="page").webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map(); const errs=[]; const dialogs=[]; const promptAnswers=[];
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}
  if(m.method==="Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
  if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error") errs.push("console: "+m.params.args.map(a=>a.value??a.description).join(" "));
  if(m.method==="Page.javascriptDialogOpening"){dialogs.push(m.params.message); send("Page.handleJavaScriptDialog",{accept:true,promptText:promptAnswers.shift()??""});}};
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true}); if(r.result.exceptionDetails) throw new Error(x.slice(0,80)+" => "+JSON.stringify(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text)); return r.result.result.value;};
const shot=async n=>{const r=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true}); fs.writeFileSync(`/tmp/pwa-e2e-run/s3-${n}.png`,Buffer.from(r.result.data,"base64"));};
const waitFor=async(expr,ms=60000)=>{const end=Date.now()+ms; while(Date.now()<end){ if(await ev(expr)) return true; await sleep(300);} throw new Error("timeout: "+expr);};
const setVal=(sel,v,type="input")=>ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); el.value=${JSON.stringify(v)}; el.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true})); return true;})()`);
const click=sel=>ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) throw new Error("no "+${JSON.stringify(sel)}); el.click(); return true;})()`);
await send("Runtime.enable"); await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
const R={};
try{
  await send("Page.navigate",{url:"http://127.0.0.1:8080/e2e.html"});
  await waitFor(`/동기화$/.test(document.querySelector("#syncStatus").textContent)`, 120000);
  // New general log.
  await click('#tabbar [data-tab="record"]'); await sleep(200);
  R.targetHint = await ev(`document.querySelector("#saveTargetHint").textContent`);
  await click("#newGeneralBtn"); await sleep(300);
  await setVal('input[data-i="0"][data-k="material"]',"HAT-CN_20_O-3","input"); await setVal('input[data-i="0"][data-k="material"]',"HAT-CN_20_O-3","change"); await sleep(200);
  R.afterCombo = await ev(`(()=>{const q=k=>document.querySelector('[data-i="0"][data-k="'+k+'"]').value; return {material:q("material"),port:q("port"),tf:q("tooling_factor"),ratio:q("ratio")};})()`);
  await setVal('input[data-i="0"][data-k="target_actual"]',"5"); await sleep(100);
  R.monitorAuto = await ev(`document.querySelector('input[data-i="0"][data-k="monitor"]').value`);
  await click('button[data-act="start"][data-i="0"]'); await sleep(100);
  for (const [k,v] of [["start_pressure","9.6"],["start_power","4.9"],["start_temp","240"],["rate","0.1"]]) await setVal(`input[data-i="0"][data-k="${k}"]`,v);
  await click('button[data-act="end"][data-i="0"]'); await sleep(100);
  for (const [k,v] of [["end_pressure","9.1"],["end_power","4.9"],["end_temp","265"],["notes","e2e 첫 층"]]) await setVal(`input[data-i="0"][data-k="${k}"]`,v);
  await click("#addLayerBtn"); await sleep(200);
  await setVal('input[data-i="1"][data-k="material"]',"CBP","input"); await setVal('input[data-i="1"][data-k="material"]',"CBP","change"); await sleep(200);
  R.layer2Auto = await ev(`(()=>{const q=k=>document.querySelector('[data-i="1"][data-k="'+k+'"]').value; return {port:q("port"),tf:q("tooling_factor"),ratio:q("ratio")};})()`);
  await setVal('input[data-i="1"][data-k="target_actual"]',"30"); await setVal('input[data-i="1"][data-k="monitor"]',"70"); 
  await setVal("#editorMemo","e2e memo");
  await sleep(600);
  R.ui = await ev(`(()=>({tabbarVisible:!document.querySelector("#tabbar").hidden, panelVisible:!document.querySelector("#structurePanel").hidden, inputFont:getComputedStyle(document.querySelector('input[data-k="material"]')).fontSize, card0Collapsed:document.querySelector('[data-card="0"]').classList.contains("collapsed"), elapsed0:document.querySelector('[data-elapsed="0"]').textContent, placeholder1:document.querySelector('[data-i="1"][data-k="start_pressure"]').placeholder}))()`);
  await sleep(100);
  R.panel = await ev(`({toggle:document.querySelector("#structureToggle").textContent, blocks:[...document.querySelectorAll("#structureBody .stack-layer")].map(b=>b.innerText.split(String.fromCharCode(10)).join(" ")), total:document.querySelector(".stack-total").textContent})`);
  await shot("1-editor");
  await click('[data-card="1"] [data-act=start]'); await ev(`window.scrollTo(0,0)`); await sleep(1500); const vp = await send("Page.captureScreenshot",{format:"png"}); fs.writeFileSync("/tmp/pwa-e2e-run/s3-1b-viewport.png", Buffer.from(vp.result.data,"base64"));
  // Leave the editor via the tab bar and come back.
  R.reopen = await ev(`(()=>{const b=document.querySelector('[data-card="0"] .toggle'); b.click(); const afterTitle=!document.querySelector('[data-card="0"]').classList.contains("collapsed"); document.querySelector('[data-card="0"] .toggle').click(); document.querySelector('[data-card="0"] .summary').click(); const afterSummary=!document.querySelector('[data-card="0"]').classList.contains("collapsed"); return {afterTitle, afterSummary};})()`);
  await click('#tabbar [data-tab="logs"]'); await sleep(200);
  R.leave = await ev(`({logsVisible:!document.querySelector("#screen-logs").hidden, panelHidden:document.querySelector("#structurePanel").hidden})`);
  await click('#tabbar [data-tab="record"]'); await sleep(200);
  // Reload: draft survives.
  await send("Page.reload"); await sleep(2500);
  await click('#tabbar [data-tab="record"]'); await sleep(300);
  R.afterReload = await ev(`(()=>({editorVisible:!document.querySelector("#editor").hidden, layers:document.querySelectorAll(".edit-layer").length, m0:document.querySelector('[data-i="0"][data-k="material"]').value, endTemp:document.querySelector('[data-i="0"][data-k="end_temp"]').value, monitor1:document.querySelector('[data-i="1"][data-k="monitor"]').value, memo:document.querySelector("#editorMemo").value}))()`);
  // Save preset.
  promptAnswers.push("E2E 프리셋");
  await click("#savePresetBtn"); await sleep(800);
  R.presetUploaded = await ev(`Object.keys(__server.files)`);
  // Upload the log.
  await click("#uploadBtn"); await waitFor(`!document.querySelector("#screen-log-detail").hidden`, 20000);
  R.detail = await ev(`(()=>({title:document.querySelector("#logDetail h2").textContent, layers:document.querySelectorAll("#logDetail .layer").length, first:document.querySelector("#logDetail .layer").innerText.replace(/\\n/g," | "), meta:document.querySelector("#logDetail .hint")?.textContent}))()`);
  R.files = await ev(`Object.entries(__server.files).map(([k,v])=>k+" "+v.mode+" "+v.rev)`);
  const logPath = (await ev(`Object.keys(__server.files)`)).find(p=>p.includes("Process_General"));
  fs.writeFileSync("/tmp/pwa-e2e-run/saved.xlsx", Buffer.from(await ev(`__server.files[${JSON.stringify(logPath)}].data`), "base64"));
  await shot("2-detail");
  // Edit in place.
  await click("#editLogBtn"); await sleep(400);
  R.editLoaded = await ev(`(()=>({title:document.querySelector("#editorTitle").textContent, layers:document.querySelectorAll(".edit-layer").length, endTemp:document.querySelector('[data-i="0"][data-k="end_temp"]').value, started:document.querySelector('[data-card="0"] .time').textContent}))()`);
  await setVal('input[data-i="0"][data-k="end_temp"]',"266"); await sleep(400);
  await click("#uploadBtn"); await waitFor(`!document.querySelector("#screen-log-detail").hidden`, 20000);
  R.afterEdit = await ev(`(()=>({files:Object.entries(__server.files).map(([k,v])=>k.split("/").pop()+" "+v.mode+" "+v.rev), meta:document.querySelector("#logDetail .hint")?.textContent}))()`);
  // Conflict: someone else changes the file, then we edit again.
  await ev(`(()=>{__server.files[${JSON.stringify(logPath)}].rev="rOTHER"; sessionStorage.setItem("e2e.server", JSON.stringify(__server)); return true})()`);
  await click("#editLogBtn"); await sleep(300);
  await setVal('input[data-i="0"][data-k="end_temp"]',"267"); await sleep(400);
  await click("#uploadBtn"); await sleep(2500);
  R.conflict = {dialogs: dialogs.slice(-2), files: await ev(`Object.keys(__server.files).map(k=>k.split("/").pop())`)};
  // Preset: start a tooling log from it, then delete it.
  await click('#tabbar [data-tab="record"]'); await sleep(300);
  R.presetList = await ev(`[...document.querySelectorAll("#presetList li")].map(li=>li.innerText.replace(/\\n/g," | "))`);
  await ev(`[...document.querySelectorAll('#presetList button[data-act="tooling"]')][0].click()`); await sleep(400);
  R.fromPreset = await ev(`(()=>({preset:document.querySelector("#editorPreset").value, layers:document.querySelectorAll(".edit-layer").length, type:document.querySelector("#editorType .active").textContent, measured: !!document.querySelector('[data-k="measured_actual"]'), target1: document.querySelector('[data-i="1"][data-k="target_actual"]').value}))()`);
  await click("#discardDraftBtn"); await sleep(300);
  await ev(`document.querySelector('#presetList button[data-act="delete"]').click()`); await sleep(800);
  R.afterDelete = await ev(`({server:Object.keys(__server.files).filter(k=>k.includes("Presets")), deleted:__server.deleted, list:document.querySelectorAll("#presetList li").length})`);
  // Log viewer stack on an existing multi-material tooling log, then delete the test log.
  await click('#tabbar [data-tab="logs"]'); await sleep(200);
  await setVal("#logSearch","PtOEP_100, CBP, Ir(ppy)3, LiF"); await sleep(200);
  await click("#logList li[data-i]"); await sleep(400);
  R.oldLogStack = await ev(`({panel:!document.querySelector("#structurePanel").hidden, blocks:document.querySelectorAll("#structureBody .stack-layer").length, first:document.querySelector("#structureBody .stack-layer")?.innerText.split(String.fromCharCode(10)).join(" "), total:document.querySelector(".stack-total")?.textContent})`);
  await shot("4-old-log-stack");
  await setVal("#logSearch","HAT-CN, CBP_general_v11"); await click('#tabbar [data-tab="logs"]'); await sleep(200);
  const before = await ev(`document.querySelectorAll("#logList li[data-i]").length`);
  await click("#logList li[data-i]"); await sleep(300);
  await click("#deleteLogBtn"); await sleep(1200);
  R.deleteLog = {before, after: await ev(`(()=>{const i=document.querySelector("#logSearch"); i.dispatchEvent(new Event("input")); return document.querySelectorAll("#logList li[data-i]").length})()`), deleted: await ev(`__server.deleted`), screenLogs: await ev(`!document.querySelector("#screen-logs").hidden`)};
  // Real (fixture) log cannot be deleted in test mode.
  await setVal("#logSearch","PtOEP_100, CBP, Ir(ppy)3, LiF"); await sleep(200); await click("#logList li[data-i]"); await sleep(300);
  await click("#deleteLogBtn"); await sleep(300);
  // Calibration list by TF.
  await click('#tabbar [data-tab="cal"]'); await sleep(200);
  await setVal("#matSearch","Ir(ppy)3"); await sleep(200);
  R.matList = await ev(`document.querySelector("#matList li").innerText.split(String.fromCharCode(10)).join(" | ")`);
  // Calibration measurement.
  await click('#tabbar [data-tab="cal"]'); await sleep(200);
  await setVal("#matSearch","Ir(ppy)3"); await sleep(200);
  await click("#matList li"); await sleep(300);
  await click("#addCalBtn"); await sleep(200);
  await setVal('input[data-f="monitor"]',"50"); await setVal('input[data-f="actual"]',"10"); await setVal('input[data-f="source"]',"O-4"); await setVal('input[data-f="toolingFactor"]',"100");
  R.calPreview = await ev(`document.querySelector("[data-ratio]").textContent`);
  await ev(`document.querySelector("[data-save]").click()`); await sleep(1200);
  R.calAfter = await ev(`({files:Object.keys(__server.files).filter(k=>k.includes("Calibration")), combos:[...document.querySelectorAll("#calDetail .combo")].map(c=>c.innerText.split("\\n").slice(0,2).join(" "))})`);
  await shot("3-cal");
}catch(e){R.error=String(e);}
R.dialogs=dialogs; R.errors=errs;
console.log(JSON.stringify(R,null,1)); ws.close(); proc.kill();
