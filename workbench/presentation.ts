import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Runtime } from '../prototype/engine.ts';
import { model, ticket, support, reviewer } from '../prototype/model.ts';

const cases = [];
for (const policy of ['approval', 'allow'] as const) for (const mutant of [false, true]) {
  const m = structuredClone(model); m.policy.support.high = policy;
  const r = new Runtime(m, ticket(), () => 1000), frames: unknown[] = [];
  const step = (label: string, result: any) => frames.push({label,result:result?[result.status,result.reason||'']:null,ticket:[r.ticket.status,r.ticket.version,r.ticket.resolution],events:r.events.map(e=>[e.id,e.kind,e.details.reason||e.details.decision||e.details.approvalMatches||''])});
  step('start', null); step('request', r.request(support, 'Fix the issue'));
  step('approve', r.approve(reviewer)); step('edit', r.editSummary('Fix the issue safely'));
  step('execute', r.execute({ staleApprovalMutant: mutant }));
  cases.push({ policy, mutant, frames });
}
const property = JSON.parse(await readFile('artifacts/property-report.json', 'utf8'));
const lean = JSON.parse(await readFile('artifacts/lean-report.json', 'utf8'));
const data = JSON.stringify({cases, property:{result:property.result,samples:property.sampleCount,
  steps:property.coverage.steps,executes:property.coverage.executes,commits:property.coverage.commits,
  seed:property.seed}, lean:{status:lean.status,tool:lean.tool.version,scope:lean.scope}}).replace(/</g,'\\u003c');
let html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--line:color-mix(in srgb,var(--text) 16%,transparent);--muted:color-mix(in srgb,var(--text) 62%,transparent);--good:#388b68;--bad:#c65d54}html,body{margin:0;background:transparent;color:var(--text);font:13px/1.45 system-ui,sans-serif}main{max-width:728px;margin:auto;padding:12px 14px;box-sizing:border-box}.bar,.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.bar{justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:10px}.eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h2{font-size:17px;margin:2px 0}button,select{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:6px 9px}button{cursor:pointer}button:hover{background:color-mix(in srgb,var(--text) 7%,transparent)}.toggle{display:flex;gap:6px;align-items:center;color:var(--muted)}.track{display:flex;gap:4px;margin:12px 0}.track button{flex:1;text-align:left;font-size:11px;color:var(--muted)}.track button.on{border-color:var(--text);color:var(--text)}.panel{border:1px solid var(--line);border-radius:8px;padding:12px}.summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.label{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.value{font-weight:600}.status{color:var(--good)}.status.bad{color:var(--bad)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace;margin:8px 0 0;max-height:175px;overflow:auto}.foot{margin-top:10px;color:var(--muted);font-size:11px}.foot strong{color:var(--text)}@media(max-width:480px){main{padding:8px}.track button{padding:5px;font-size:10px}.summary{grid-template-columns:1fr 1fr}}
</style><main><div class="bar"><div><div class="eyebrow">Runtime field note · approval snapshot</div><h2>Can an old approval still commit?</h2></div><label class="toggle">Policy <select id="policy"><option>approval</option><option>allow</option></select></label><label class="toggle"><input id="bug" type="checkbox"> Deliberate bug</label></div><div class="track" id="track"></div><section class="panel" id="view"></section><div class="row" style="justify-content:space-between;margin-top:9px"><button id="prev">← Back</button><span id="count" class="eyebrow"></span><button id="next">Next →</button></div><div class="foot" id="evidence"></div></main><script>const D=${data};let n=0;const $=x=>document.getElementById(x),labels=['start','request','approve','edit','execute'];function draw(){let c=D.cases.find(x=>x.policy===$('policy').value&&x.mutant===$('bug').checked),f=c.frames[n];$('track').innerHTML=labels.map((x,i)=>'<button class="'+(i===n?'on':'')+'" data-i="'+i+'">'+(i+1)+' · '+x+'</button>').join('');$('track').querySelectorAll('button').forEach(b=>b.onclick=()=>{n=+b.dataset.i;draw()});let bad=c.mutant&&c.policy==='approval'&&n===4,decision=f.events.find(e=>e[1]==='requested')?.[2]||'—';$('view').innerHTML='<div class="summary"><div><div class="label">Policy outcome</div><div class="value">'+decision+'</div></div><div><div class="label">Run result</div><div class="value status '+(bad?'bad':'')+'">'+(bad?'BUG: stale approval committed':f.result?.[1]||f.result?.[0]||'Ready')+'</div></div><div><div class="label">Ticket</div><div class="value">'+f.ticket[0]+' · v'+f.ticket[1]+'</div></div><div><div class="label">Resolution</div><div class="value">'+(f.ticket[2]||'—')+'</div></div></div><div class="label">Actual Runtime events · '+f.events.length+'</div><pre>'+JSON.stringify(f.events,null,2)+'</pre>';$('count').textContent='STEP '+(n+1)+' / 5';$('prev').disabled=n===0;$('next').disabled=n===4;$('evidence').innerHTML='<strong>Evidence boundary</strong> · '+D.property.samples+' seeded histories: '+D.property.result+' ('+D.property.steps+' steps, '+D.property.executes+' executes, '+D.property.commits+' commits). Lean: '+D.lean.status+' — '+D.lean.tool+'. Not a TypeScript proof.'} $('policy').onchange=()=>{n=0;draw()};$('bug').onchange=()=>{n=0;draw()};$('prev').onclick=()=>{n=Math.max(0,n-1);draw()};$('next').onclick=()=>{n=Math.min(4,n+1);draw()};draw();</script>`;
html = html.replace('--good:#388b68;--bad:#c65d54', '--text:var(--foreground);--good:var(--success);--bad:var(--destructive)')
  .replace('padding:12px 14px', 'padding:0').replace('main{padding:8px}', 'main{padding:0}')
  .replace('border-radius:8px;padding:12px', 'border-radius:var(--radius);padding:16px')
  .replace('<div><div class="eyebrow">Runtime field note · approval snapshot</div><h2>Can an old approval still commit?</h2></div>', '')
  .replace('let n=0;', 'let n=4;')
  .replace('Actual Runtime events', 'Recorded simulation events');
if (html.length > 12000) throw new Error(`Presentation too large: ${html.length}`);
await mkdir(resolve('artifacts'), { recursive: true });
await writeFile(resolve('artifacts/presentation.html'), html);
console.log(`Built artifacts/presentation.html (${html.length} characters)`);
