// Shared presentation semantics. Terms are conjunctions of signed observations;
// both the runtime classifier and the compiled guards consume this table.
type Observation='owned'|'pending'|'failed';
type Facts=Readonly<Record<Observation,boolean>>;
type Term=Observation|`!${Observation}`;
const phases:Readonly<Record<string,readonly Term[]>>={initial:['!owned','pending'],refreshing:['owned','pending'],ready:['owned','!pending','!failed'],failed:['!owned','!pending','failed'],stale:['owned','!pending','failed'],idle:['!owned','!pending','!failed']};
function observation(term:Term):Observation {
  switch(term){
    case '!owned':return 'owned';
    case '!pending':return 'pending';
    case '!failed':return 'failed';
    default:return term;
  }
}
export function lifecyclePhase(facts:Facts){return Object.entries(phases).find(([,terms])=>terms.every(term=>term.startsWith('!')?!facts[observation(term)]:facts[observation(term)]))?.[0];}
export function lifecycleGuard(phase:string,bindings:Readonly<Partial<Record<Observation,string>>>){
  const terms=Object.hasOwn(phases,phase)?phases[phase]:undefined;
  if(!terms)throw Error(`Unknown loading phase: ${phase}`);
  return terms.map(term=>{const key=observation(term),binding=bindings[key];if(!binding)throw Error(`Missing loading observation: ${key}`);return `${term.startsWith('!')?'not ':''}(${binding})`;}).join(' and ');
}
export const loadingModes=Object.freeze(['text','icon','skeleton','wait']);
export function loadingPlan(contract:{loading?:string;views:readonly {label:string;loading?:string}[]}){
  function check(s:string|undefined){if(s!==undefined&&!loadingModes.includes(s))throw Error(`Invalid loading strategy: ${s}`);return s;}
  const fallback=check(contract.loading)??'text';
  return contract.views.map(({label,loading},index)=>({index,label,strategy:check(loading)??fallback}));
}
export function loadingPresentation(strategy:string,facts:Facts){
  const phase=lifecyclePhase(facts);
  return {phase,showContent:!!facts.owned,placeholder:phase==='initial'&&strategy!=='wait'?strategy:null,error:phase==='failed'||phase==='stale'};
}
