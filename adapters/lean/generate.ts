import {errorMessage} from '../../errors.ts';
import {createHash} from 'node:crypto';
import {validateModel} from '../../semantic/core.ts';
import {render} from './template.ts';

export const ADAPTER = 'shared-ir-lean-numeric/1';
export const PROJECTION = 'single-static-record-numeric-kernel/1';
export const MAX = 9007199254740991;
export const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
export const hash = x => createHash('sha256').update(typeof x === 'string' ? x : canonical(x)).digest('hex');
export class Unsupported extends Error {}
const fail = s => {throw new Unsupported(s);};
const ident = s => /^[a-z][A-Za-z0-9_]*$/.test(s) && !['version', 'revision', 'clock', 'end', 'def', 'theorem', 'match', 'if', 'then', 'else'].includes(s) ? s : fail(`Unsupported Lean field/input name: ${s}`);
const and = xs => xs.length ? xs.map(x => `(${x})`).join(' ∧ ') : 'True';
const integer = x => Number.isSafeInteger(x) && !Object.is(x, -0) ? `(${x} : Int)` : fail('Unsafe integer');

export function generate(source, law) {
  try { validateModel(source); } catch (e) { fail(`Invalid shared IR: ${errorMessage(e)}`); }
  if (law.format !== 'numeric-law/v1') fail('Unsupported law format');
  const action = source.actions[law.action];
  if (!action || action.bindings.length !== 1) fail('Exactly one static binding required');
  const binding = action.bindings[0];
  if (binding.key.op !== 'literal' || typeof binding.key.value !== 'string') fail('Static literal record key required');
  const fields = source.resources[binding.resource].fields;
  const schema = (s, value) => {
    if (s.type !== 'integer') fail('Only integer schemas supported in selected resource and inputs');
    return and([`safe ${value}`, ...(s.min === undefined ? [] : [`${integer(s.min)} ≤ ${value}`]), ...(s.max === undefined ? [] : [`${value} ≤ ${integer(s.max)}`])]);
  };
  Object.keys(fields).forEach(ident); Object.keys(action.inputs).forEach(ident);
  const boolean = e => ['not', 'lt', 'le', 'eq', 'and', 'or'].includes(e.op) || (e.op === 'literal' && typeof e.value === 'boolean');
  for (const u of action.updates) if (u.target !== binding.id) fail('Foreign binding');
  if (new Set(action.updates.map(u => u.field)).size !== action.updates.length) fail('Aliasing updates');
  const expr = (e, checks, mode = 'transition') => {
    switch (e.op) {
      case 'literal': return typeof e.value === 'boolean' ? (e.value ? 'True' : 'False') : integer(e.value);
      case 'input': if (!Object.hasOwn(action.inputs, e.name)) fail('Unknown input'); return `i.${ident(e.name)}`;
      case 'clock': return 'i.clock';
      case 'field': if (e.binding !== binding.id || !Object.hasOwn(fields, e.field)) fail('Unknown field'); return `s.${ident(e.field)}`;
      case 'pre': case 'post': if (mode !== 'law' || !Object.hasOwn(fields, e.field)) fail('Unknown law field'); return `${e.op === 'pre' ? 's' : 't'}.${ident(e.field)}`;
      case 'not': return `(¬ ${expr(e.value, checks, mode)})`;
      case 'add': case 'sub': case 'le': case 'lt': case 'eq': case 'and': case 'or': {
        const a = expr(e.left, checks, mode), b = expr(e.right, checks, mode);
        const operator = e.op === 'eq' && boolean(e.left) ? '↔' : {add: '+', sub: '-', le: '≤', lt: '<', eq: '=', and: '∧', or: '∨'}[e.op];
        const text = `(${a} ${operator} ${b})`;
        if (mode === 'transition' && ['add', 'sub'].includes(e.op)) checks.push(`safe ${text}`);
        return text;
      }
      default: return fail(`Unsupported expression: ${e.op}`);
    }
  };
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(law.id)) fail('Unsupported law ID');
  const guards = action.preconditions.map(p => {
    const checks = [];
    return {value: expr(p.when, checks), checks};
  });
  const updateNodes = action.updates.map(u => {
    const checks = [];
    return {...u, expression: expr(u.value, checks), checks};
  });
  const updates = Object.fromEntries(updateNodes.map(u => [u.field, u.expression]));
  const valid = and([...Object.entries(fields).map(([k, v]) => schema(v, `s.${k}`)), ...Object.entries(action.inputs).map(([k, v]) => schema(v, `i.${k}`)), 'safe s.revision', '0 ≤ s.revision', 'safe s.version', '0 ≤ s.version', 'safe i.clock', '0 ≤ i.clock']);
  const overflow = and(['safe (s.revision + 1)', ...(action.updates.length ? ['safe (s.version + 1)'] : [])]);
  const candidate = `{ ${[...Object.keys(fields).map(k => `${k} := ${updates[k] ?? `s.${k}`}`), 'revision := s.revision + 1', `version := s.version + ${action.updates.length ? 1 : 0}`].join(', ')} }`;
  const ensures = expr(law.ensures, [], 'law');
  const stateValue = v => `{ ${[...Object.keys(fields), 'revision', 'version'].map(k => `${k} := ${integer(v[k])}`).join(', ')} }`;
  const inputsValue = v => `{ ${[...Object.keys(action.inputs), 'clock'].map(k => `${k} := ${integer(v[k])}`).join(', ')} }`;
  const metadata = {
    format: 'generated-lean-metadata/1', adapter: ADAPTER, projection: PROJECTION,
    source_format: source.format, source_id: source.id, source_sha256: hash(source), obligation_sha256: hash(law),
    source, obligation: law, action_id: law.action, binding,
    declaration_ids: [source.id, binding.resource, law.action, binding.id, ...action.preconditions.map(x => x.id), ...action.updates.map(x => x.id)],
    excluded_policy_ids: action.policies.map(x => x.id),
    excluded_relationship_ids: source.relationships.map(x => x.id),
    exclusions: ['all policies and authorization outcomes', 'relationships, observation, routing, events', 'other resources and actions', 'record lookup/missing records, string values and actor', 'commit tokens, stale snapshots, concurrency, persistence, external execution'],
    assumptions: ['one existing statically selected record', 'single synchronous numeric step', 'valid safe integer state, inputs and clock required by successful result', 'authorization is NOT modeled'],
    correspondence: 'Not proved. Executed finite differential tests only.',
  };
  // Ordered preconditions precede grouped updates. Each guard's operands are eager.
  let body = `if ${overflow} then .committed ${candidate}\nelse .overflow`;
  for (const update of [...updateNodes].reverse()) {
    body = `if ${and(update.checks)} then\n  if ${schema(fields[update.field], update.expression)} then\n${body.split('\n').map(l => '    ' + l).join('\n')}\n  else .schema\nelse .overflow`;
  }
  for (const guard of [...guards].reverse()) {
    body = `if ${and(guard.checks)} then\n  if ${guard.value} then\n${body.split('\n').map(l => '    ' + l).join('\n')}\n  else .precondition\nelse .overflow`;
  }
  body = `if ${valid} then\n${body.split('\n').map(l => '  ' + l).join('\n')}\nelse .invalid`;
  const code = render({adapter: ADAPTER, projection: PROJECTION, metadata, max: MAX,
    fields: Object.keys(fields), inputs: Object.keys(action.inputs), body,
    lawId: law.id, ensures, witnessPre: stateValue(law.witness.pre),
    witnessInputs: inputsValue(law.witness.inputs), witnessPost: stateValue(law.witness.post)});
  return {code, metadata: {...metadata, generated_sha256: hash(code)}};
}
