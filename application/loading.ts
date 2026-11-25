// Shared presentation semantics. Terms are conjunctions of signed observations;
// both the runtime classifier and the compiled guards consume this table.
const phases={initial:['!owned','pending'],refreshing:['owned','pending'],ready:['owned','!pending','!failed'],failed:['!owned','!pending','failed'],stale:['owned','!pending','failed'],idle:['!owned','!pending','!failed']};
export function lifecyclePhase(facts){return Object.keys(phases).find(k=>phases[k].every(term=>term[0]==='!'?!facts[term.slice(1)]:facts[term]));}
export function lifecycleGuard(phase,bindings){
  if(!Object.hasOwn(phases,phase))throw Error(`Unknown loading phase: ${phase}`);
  return phases[phase].map(term=>{const neg=term.startsWith('!'),key=neg?term.slice(1):term;if(!bindings[key])throw Error(`Missing loading observation: ${key}`);return `${neg?'not ':''}(${bindings[key]})`;}).join(' and ');
}
export const loadingModes=Object.freeze(['text','icon','skeleton','wait']);
export function loadingPlan(contract){
  function check(s){if(s!==undefined&&!loadingModes.includes(s))throw Error(`Invalid loading strategy: ${s}`);return s;}
  const fallback=check(contract.loading)??'text';
  return contract.views.map(({label,loading},index)=>({index,label,strategy:check(loading)??fallback}));
}
export function loadingPresentation(strategy,facts){
  const phase=lifecyclePhase(facts);
  return {phase,showContent:!!facts.owned,placeholder:phase==='initial'&&strategy!=='wait'?strategy:null,error:phase==='failed'||phase==='stale'};
}
