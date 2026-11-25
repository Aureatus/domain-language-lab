import {createInterpreter,validateState} from '../semantic/core.ts';
import type {Committed, Event, Invocation, Model, Preparation, Prepared, State} from '../semantic/core.ts';
import {inventoryModel,initialState,invocation} from './model.ts';
import {inspectInventory} from './oracle.ts';
export const HOST_VERSION='inventory-host/v1';
type Operation = {type:'prepare'; token:string; invocation:Invocation}
  | {type:'commit'; token:string; mutant?:boolean}
  | {type:'execute'; invocation:Invocation};
type Observation = {status: Preparation['status'] | Committed['status']; code?: string; reason?: string; revision: number; oracle: ReturnType<typeof inspectInventory>; events: Event[]};
type Step = {operation: Operation; observation: Observation};
interface ReplayBundle {
  format: string;
  host: string;
  model: Model;
  initial: State;
  steps: Step[];
  final: State;
}

export function createHost(model: Model=inventoryModel,initial=initialState) {
  const runtime=createInterpreter(model);
  const tokens=new Map<string,{token: Prepared; snapshot: State; invocation: Invocation}>();
  const steps: Step[]=[], accepted: Invocation[]=[], events: Event[]=[];
  const usedIds=new Set<string>();
  model=runtime.model;initial=validateState(model,initial);
  let state=initial;
  function step(operation: Operation): Observation {
    let result: Preparation | Committed;
    if((operation.type==='prepare'||operation.type==='execute')&&usedIds.has(operation.invocation.id)) {
      result={status:'rejected',code:'invalid',reason:'duplicate-invocation',state};
    } else if(operation.type==='prepare') {
      usedIds.add(operation.invocation.id);
      result=runtime.prepare(state,operation.invocation);
      if(result.status==='prepared') tokens.set(operation.token,{token:result.prepared,snapshot:state,invocation:operation.invocation});
    } else if(operation.type==='commit') {
      const saved=tokens.get(operation.token);
      if(!saved) throw new Error('Unknown preparation token');
      result=runtime.commit(operation.mutant?saved.snapshot:state,saved.token);
      if(result.status==='committed') accepted.push(saved.invocation);
    } else if(operation.type==='execute') {
      usedIds.add(operation.invocation.id);
      result=runtime.execute(state,operation.invocation);
      if(result.status==='committed') accepted.push(operation.invocation);
    } else throw new Error('Unsupported host operation');
    if(result.status==='committed') {state=result.state;events.push(...result.events);}
    const observation={status:result.status,...(result.status==='rejected'&&result.code?{code:result.code,reason:result.reason}:{}),revision:state.revision,oracle:inspectInventory(state,accepted),events:result.status==='committed'?result.events:[]};
    steps.push({operation:structuredClone(operation),observation});
    return observation;
  }
  return {step,get state(){return state;},get steps(){return steps;},get events(){return events;},get oracle(){return inspectInventory(state,accepted);},export(){return {format:'inventory-replay/v1',host:HOST_VERSION,model,initial,steps:structuredClone(steps),final:state};}};
}
export function replay(bundle: ReplayBundle) {
  if(bundle.format!=='inventory-replay/v1'||bundle.host!==HOST_VERSION) throw new Error('Unsupported replay');
  const host=createHost(bundle.model,bundle.initial);
  for(const {operation,observation} of bundle.steps) {
    const actual=host.step(operation);
    if(JSON.stringify(actual)!==JSON.stringify(observation)) throw new Error('Replay observation mismatch');
  }
  if(JSON.stringify(host.state)!==JSON.stringify(bundle.final)) throw new Error('Replay final mismatch');
  return host;
}
export function competition(mutant=false,order=['A','B']) {
  const host=createHost();
  for(const name of ['A','B']) host.step({type:'prepare',token:name,invocation:invocation(`race${name}`,'reserve',`slot${name}`,name==='A'?'alice':'bob')});
  for(const token of order) host.step({type:'commit',token,mutant});
  if(!mutant) {
    const loser=order[1];
    host.step({type:'execute',invocation:invocation(`retry${loser}`,'reserve',`slot${loser}`,loser==='A'?'alice':'bob')});
    host.step({type:'execute',invocation:invocation(`fit${loser}`,'reserve',`slot${loser}`,loser==='A'?'alice':'bob',10,2)});
  }
  return host;
}
