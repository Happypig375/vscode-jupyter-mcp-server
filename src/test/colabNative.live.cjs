// Opt-in real VS Code renderer test. Uses a fresh profile and a synthetic extension;
// never opens Colab, user workspaces, authentication, or the normal extension directory.
// Usage: node src/test/colabNative.live.cjs <absolute Code executable> <new evidence directory>
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');
const [code, evidenceArg] = process.argv.slice(2);
if (!code || !path.isAbsolute(code) || !evidenceArg || !path.isAbsolute(evidenceArg)) throw new Error('Explicit absolute executable and new evidence directory required.');
const evidence = path.resolve(evidenceArg);
const marker = 'MCP Colab setup ' + crypto.randomUUID();
const receipt = { startedAt: new Date().toISOString(), orcaUsed: false, realColabUsed: false, smokeDriverFlag: false, marker };
let child, control, driver;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 40000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(200); }
    throw new Error(label);
}
async function connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', () => reject(new Error('fixture debugger unavailable')), {once:true}); });
    let id = 0; const pending = new Map();
    socket.addEventListener('message', event => { const m=JSON.parse(event.data); const job=pending.get(m.id); if(!job)return; pending.delete(m.id);clearTimeout(job.timer);m.error?job.reject(new Error('fixture protocol error')):job.resolve(m.result); });
    return { close: () => socket.close(), command: (method,params={}) => new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('fixture command timeout'));},10000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));}) };
}
async function main() {
    await fs.mkdir(evidence); // Never overwrite a prior live attempt.
    const fixture = path.join(evidence,'fixture'), profile = path.join(evidence,'profile'), extensions = path.join(evidence,'extensions');
    for (const dir of [fixture,profile,extensions]) await fs.mkdir(dir);
    const acknowledgment = path.join(evidence,'acknowledgment.json');
    await fs.writeFile(path.join(fixture,'package.json'), JSON.stringify({name:'native-colab-fixture',publisher:'local-test',version:'0.0.1',engines:{vscode:'^1.106.0'},main:'./extension.cjs',activationEvents:['onStartupFinished']}));
    await fs.writeFile(path.join(fixture,'extension.cjs'), `const vscode=require('vscode');const fs=require('node:fs');
exports.activate=async context=>{
 const marker=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,1000000);marker.text=${JSON.stringify(marker)};marker.show();context.subscriptions.push(marker);
 const picks=[]; const choose=async(title,labels)=>{const v=await vscode.window.showQuickPick(labels,{title,placeHolder:title});picks.push(v);return v;};
 await choose('Select Kernel',['Colab','Other source']);
 await choose('Select a Jupyter Server',['New Colab Server','Unrelated server']);
 await choose('Select a variant',['CPU','GPU']);
 await choose('Select a machine shape',['Standard','High-RAM']);
 await choose('Select a runtime version',['Latest','Old']);
 const alias=await vscode.window.showInputBox({title:'Colab CPU',placeHolder:'Alias your server'});picks.push(alias);
 await choose('Select a Kernel from '+alias,['Python default','Python explicit second']);
 await choose('Mount Server to Workspace',[alias,'Unrelated server']);
 fs.writeFileSync(${JSON.stringify(acknowledgment)},JSON.stringify({picks,marker:marker.text}));
};`);
    const bundle=path.join(evidence,'native-driver.cjs');
    await esbuild.build({entryPoints:[path.join(__dirname,'..','colabNative.ts')],outfile:bundle,bundle:true,platform:'node',target:'node20',format:'cjs'});
    child=spawn(code,[`--user-data-dir=${profile}`,`--extensions-dir=${extensions}`,`--extensionDevelopmentPath=${fixture}`,'--remote-debugging-port=0','--skip-welcome','--skip-release-notes','--disable-telemetry','--new-window'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    receipt.pid=child.pid; let logs='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(logs.length<200000)logs+=chunk.toString();});
    const port=await until(async()=>{try{const v=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];if(/^\d+$/.test(v))return Number(v);}catch{}const m=logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);return m?Number(m[1]):false;},'no fixture debug port');
    receipt.port=port;
    const target=await until(async()=>{try{const list=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());return list.find(t=>t.type==='page'&&/workbench(?:\.html)?/.test(t.url));}catch{return false;}},'no fixture workbench');
    if(!target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`))throw new Error('unexpected fixture endpoint');
    control=await connect(target.webSocketDebuggerUrl);
    const smokeProbe=await control.command('Runtime.evaluate',{expression:'typeof window.driver',returnByValue:true});
    receipt.windowDriverType=smokeProbe.result?.value;
    if(receipt.windowDriverType!=='undefined')throw new Error('fixture unexpectedly exposes the smoke driver');
    await until(async()=>{const r=await control.command('Runtime.evaluate',{expression:`[...document.querySelectorAll('.statusbar-item-label')].some(e=>e.textContent.trim()===${JSON.stringify(marker)})`,returnByValue:true});return r.result?.value===true;},'fixture marker not ready');
    const {createColabNativeDriver}=require(bundle); driver=createColabNativeDriver(port); const signal=new AbortController().signal;
    await driver.bind(marker,signal);
    await driver.choose(['Select Kernel'],['Colab'],signal);
    await driver.choose(['Select a Jupyter Server'],['New Colab Server'],signal);
    await driver.choose(['Select a variant'],['CPU'],signal);
    await driver.choose(['Select a machine shape'],['Standard'],signal);
    await driver.choose(['Select a runtime version'],['Latest'],signal);
    await driver.enter(['Alias your server'],'m12345678',signal);
    const choices=await driver.listChoices(['Select a Kernel from m12345678'],signal);
    if(choices.length!==2||choices[1].label!=='Python explicit second')throw new Error('wrong native listing');
    await pause(200);
    try{await fs.access(acknowledgment);throw new Error('listing unexpectedly submitted');}catch(e){if(e.code!=='ENOENT')throw e;}
    receipt.choices=choices;receipt.listingDidNotSubmit=true;
    await driver.chooseListed(['Select a Kernel from m12345678'],choices[1].choiceId,signal);
    await driver.choose(['Mount Server to Workspace'],['m12345678'],signal);
    const ack=await until(async()=>{try{return JSON.parse(await fs.readFile(acknowledgment,'utf8'));}catch{return false;}},'no exact fixture acknowledgment');
    const expected=['Colab','New Colab Server','CPU','Standard','Latest','m12345678','Python explicit second','m12345678'];
    if(ack.marker!==marker||JSON.stringify(ack.picks)!==JSON.stringify(expected))throw new Error('wrong fixture selection acknowledgment');
    receipt.picks=ack.picks;receipt.passed=true;
}
main().catch(error=>{receipt.passed=false;receipt.error=String(error.message);process.exitCode=1;}).finally(async()=>{
    driver?.dispose();
    if(control){try{await control.command('Browser.close');receipt.closeRequested=true;}catch{receipt.closeRequested='unconfirmed';}control.close();}
    else if(child){child.kill();receipt.ownedProcessKillRequested=true;}
    receipt.finishedAt=new Date().toISOString();
    try{await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));}catch{}
    console.log(JSON.stringify(receipt,null,2));
});
