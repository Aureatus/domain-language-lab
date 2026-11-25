import {mkdir, writeFile} from 'node:fs/promises';
import {createApp} from './core.ts';

type Runtime = ReturnType<typeof createApp>;
type Dispatch = ReturnType<Runtime['dispatch']>;
type RulePatch = {allowedRoles?: string[]; notify?: string[]};
type Args = Record<string, string | null>;
type History = {kind: 'dispatch'; action: string; args: Args; actor: string}
  | {kind: 'setRule'; action: string; patch: RulePatch};
type Wrapper = {
  dispatch?(this: Runtime, ...args: Parameters<Runtime['dispatch']>): Dispatch | {ok: true; event?: never};
  setRule?: Runtime['setRule'];
};
interface Options {
  seed?: number;
  runs?: number;
  maxSteps?: number;
  wrapper?: Wrapper;
}

const ACTIONS = ['create', 'assign', 'comment', 'resolve', 'reopen', 'watch'];
const PATHS = ['opener', 'assignee', 'watchers'];
const ROLES = ['lead', 'member'];
const clone = x => JSON.parse(JSON.stringify(x));
function rng(seed) { let x = seed >>> 0; return () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

// Deliberately independent of core.check()/its private routing helper.
function oracleRoute(issue, paths, actor) {
  const byUser = new Map();
  for (const path of paths) for (const id of (path === 'watchers' ? issue.watchers : [issue[path]])) {
    if (!id || id === actor) continue;
    let row = byUser.get(id); if (!row) byUser.set(id, row = {recipient:id, reasons:[], paths:[]});
    row.reasons.push(path); row.paths.push({from:issue.id, relationship:path, to:id});
  }
  return [...byUser.values()];
}
function issueAfter(state, action, args, actor, timestamp) {
  if (action === 'create') return {id:`i${state.issues.length+1}`, title:args.title, description:args.description ?? '', priority:args.priority ?? 'normal', status:'open', opener:actor, assignee:null, watchers:[], comments:[], version:1};
  const old = state.issues.find(x => x.id === args.issueId); if (!old) return null;
  const next = clone(old); next.version++;
  if (action === 'assign') next.assignee = args.assignee;
  if (action === 'comment') next.comments.push({id:`c${state.events.length+1}`,author:actor,body:args.body,createdAt:timestamp});
  if (action === 'resolve') next.status = 'resolved';
  if (action === 'reopen') next.status = 'open';
  if (action === 'watch') next.watchers = next.watchers.includes(actor) ? next.watchers.filter(x=>x!==actor) : [...next.watchers,actor];
  return next;
}
function permitted(state, model, action, actor) { const user=state.users.find(u=>u.id===actor); return !!user && model.actions[action].allowedRoles.includes(user.role); }
function validateCandidate(state, action, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const hasIssue = () => state.issues.some(i=>i.id===args.issueId);
  if (action==='create') return typeof args.title==='string' && !!args.title.trim() && args.title.length<=160 && (args.description===undefined || typeof args.description==='string'&&args.description.length<=5000) && (args.priority===undefined || ['normal','high'].includes(args.priority)) && Object.keys(args).every(k=>['title','description','priority'].includes(k));
  if (!hasIssue()) return false;
  if (action==='assign') return Object.keys(args).sort().join() === 'assignee,issueId' && (args.assignee===null || state.users.some(u=>u.id===args.assignee));
  if (action==='comment') return Object.keys(args).sort().join()==='body,issueId' && typeof args.body==='string' && !!args.body.trim() && args.body.length<=5000;
  if (['resolve','reopen','watch'].includes(action)) return Object.keys(args).join()==='issueId';
  return false;
}
function domainValid(state, action, args) { const i=state.issues.find(x=>x.id===args.issueId); return action==='resolve' ? i?.status==='open' : action==='reopen' ? i?.status==='resolved' : action==='assign' ? i?.assignee!==args.assignee : true; }

function trial(seed: number, maxSteps: number, wrapper?: Wrapper) {
  const r=rng(seed), app=createApp({clock:()=>1700000000000+app.state.events.length});
  const coverage={actions:Object.fromEntries(ACTIONS.map(a=>[a,0])),acceptedActions:Object.fromEntries(ACTIONS.map(a=>[a,0])),denials:0,rejections:0,ruleEdits:0,invalidReferences:0,notificationPaths:Object.fromEntries(PATHS.map(p=>[p,0]))};
  const history: History[] = [];
  const snapshots: {state: Runtime['state']; model: Runtime['model']; stateJSON: string; modelJSON: string}[] = [];
  const snapshotsStable = () => snapshots.every(s => JSON.stringify(s.state) === s.stateJSON && JSON.stringify(s.model) === s.modelJSON);
  for(let step=0;step<maxSteps;step++) {
    const before=app.state, modelBefore=app.model; snapshots.push({state:before,model:modelBefore,stateJSON:JSON.stringify(before),modelJSON:JSON.stringify(modelBefore)});
    if(r()<.22) {
      const action=pick(r,ACTIONS), patch=pick(r,[{allowedRoles:[...ROLES]},{allowedRoles:['lead']},{allowedRoles:['member']},{allowedRoles:[]},{notify:[...PATHS]},{notify:[pick(r,PATHS)]},{notify:[]}]);
      const expected=Object.keys(patch).every(k=>k==='notify'?Array.isArray(patch[k])&&patch[k].every(x=>PATHS.includes(x))&&new Set(patch[k]).size===patch[k].length:Array.isArray(patch[k])&&patch[k].every(x=>ROLES.includes(x))&&new Set(patch[k]).size===patch[k].length);
      const result=(wrapper?.setRule ?? app.setRule).call(app,action,patch); history.push({kind:'setRule',action,patch});
      if(!snapshotsStable()) return {failed:true as const,history,why:'historical snapshot lost immutability'};
      if(result.ok!==expected || (!expected && app.model!==modelBefore) || (expected && app.model.revision!==modelBefore.revision+1)) return {failed:true as const,history,why:'setRule outcome/revision mismatch'};
      if(result.ok) coverage.ruleEdits++; continue;
    }
    const action=ACTIONS[step%ACTIONS.length], actor=pick(r,['u1','u2','u3','nobody']);
    const args: Args=action==='create'?{title:`generated ${seed}-${step}`,...(r()<.35?{}:{priority:pick(r,['normal','high'])})}: {issueId:r()<.12?'missing':pick(r,before.issues).id};
    if(action==='assign') args['assignee']=pick(r,['u1','u2','u3',null,'missing']);
    if(action==='comment') args['body']=r()<.12?'  ':`comment ${step}`;
    if(!validateCandidate(before,action,args) && args['issueId']==='missing') coverage.invalidReferences++;
    const allowed=permitted(before,modelBefore,action,actor), valid=validateCandidate(before,action,args), domain=valid&&domainValid(before,action,args), expected=allowed&&valid&&domain;
    const result=(wrapper?.dispatch ?? app.dispatch).call(app,action,args,actor); history.push({kind:'dispatch',action,args,actor});
    if(!snapshotsStable()) return {failed:true as const,history,why:'historical snapshot lost immutability'};
    coverage.actions[action]++;
    if(!allowed) coverage.denials++;
    if(result.ok!==expected) return {failed:true as const,history,why:`${action}: expected ok=${expected}, got ${result.ok}`};
    if(!result.ok) { coverage.rejections++; if(app.state!==before || app.model!==modelBefore) return {failed:true as const,history,why:'rejected operation changed state/model'}; continue; }
    coverage.acceptedActions[action]++;
    const expectedIssue=issueAfter(before,action,args,actor,1700000000000+before.events.length), now=app.state, actual=now.issues.find(x=>x.id===expectedIssue.id), rule=modelBefore.actions[action];
    if(JSON.stringify(actual)!==JSON.stringify(expectedIssue)) return {failed:true as const,history,why:'issue transition differs from independent oracle'};
    const event=result.event, route=oracleRoute(expectedIssue,rule.notify,actor);
    if(!event || JSON.stringify(event.recipients)!==JSON.stringify(route)) return {failed:true as const,history,why:'notification route differs from declared-path oracle'};
    for(const x of rule.notify) coverage.notificationPaths[x]++;
    if(event.actorId!==actor || event.revision!==modelBefore.revision || event.rule.allowedRoles.includes(before.users.find(u=>u.id===actor).role)===false) return {failed:true as const,history,why:'event policy snapshot mismatch'};
  }
  const rebuilt=createApp({workspace:app.exportWorkspace()});
  if(JSON.stringify(rebuilt.state)!==JSON.stringify(app.state)||JSON.stringify(rebuilt.model)!==JSON.stringify(app.model)) return {failed:true as const,history,why:'journal reconstruction differs from live state'};
  return {failed:false as const,history,coverage};
}

export function runGenerated({seed=0x51eed,runs=40,maxSteps=80,wrapper}: Options = {}) {
  if(!Number.isInteger(seed)||!Number.isInteger(runs)||runs<1||!Number.isInteger(maxSteps)||maxSteps<1) throw Error('seed, runs and maxSteps must be valid integers');
  const aggregate={actions:Object.fromEntries(ACTIONS.map(a=>[a,0])),acceptedActions:Object.fromEntries(ACTIONS.map(a=>[a,0])),denials:0,rejections:0,ruleEdits:0,invalidReferences:0,notificationPaths:Object.fromEntries(PATHS.map(p=>[p,0]))};
  for(let n=0;n<runs;n++) { const run=trial((seed+n)>>>0,maxSteps,wrapper); if(run.failed) {
      // Prefix minimization is deterministic. A fresh replay determines whether each prefix still fails.
      let lo=1,hi=run.history.length; while(lo<hi){const mid=Math.floor((lo+hi)/2); if(trial((seed+n)>>>0,mid,wrapper).failed) hi=mid; else lo=mid+1;}
      return {status:'counterexample' as const,seed:(seed+n)>>>0,runs:n+1,maxSteps,actionsExecuted:run.history.length,coverage:aggregate,counterexample:{history:run.history.slice(0,lo),why:run.why}};
    }
    for(const a of ACTIONS) {aggregate.actions[a]+=run.coverage.actions[a];aggregate.acceptedActions[a]+=run.coverage.acceptedActions[a];} for(const k of ['denials','rejections','ruleEdits','invalidReferences']) aggregate[k]+=run.coverage[k]; for(const p of PATHS) aggregate.notificationPaths[p]+=run.coverage.notificationPaths[p];
  }
  return {status:'sampled_pass' as const,seed,runs,maxSteps,actionsExecuted:Object.values(aggregate.actions).reduce((a,b)=>a+b,0),coverage:aggregate};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report=runGenerated({seed:Number(process.env['SEED']??0x51eed),runs:Number(process.env['RUNS']??40),maxSteps:Number(process.env['MAX_STEPS']??80)});
  await mkdir('artifacts',{recursive:true}); await writeFile('artifacts/live-generated-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2)); if(report.status==='counterexample') process.exitCode=1;
}
