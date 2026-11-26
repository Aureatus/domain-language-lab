import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generate, hash, Unsupported} from './generate.ts';
import {model, obligation} from './fixture.ts';
import {decodeJsonObject, encodeJsonPretty} from '../effect/json.ts';

export const PINNED_LEAN = '/tmp/opencode/elan/toolchains/leanprover--lean4---v4.19.0/bin/lean';
type Report = {format:string;status:'tool_error'|'not_checked'|'proof_checked'|'unsupported';
  theorem_axioms:Record<string,string[]>;tool:{executable:string;version:string|null};scope:string;
  metadata?:ReturnType<typeof generate>['metadata'];generator_sha256?:string;template_sha256?:string;
  runner_sha256?:string;semantic_core_sha256?:string;detail?:string};
export function check(source, law, directory, lean = process.env.LEAN || PINNED_LEAN) {
  mkdirSync(directory, {recursive: true});
  const report: Report = {format: 'generated-lean-evidence/1', status: 'tool_error', theorem_axioms: {}, tool: {executable: lean, version: null}, scope: 'Generated numeric kernel only; no runtime correspondence or full-action theorem.'};
  let log = '';
  try {
    const {code, metadata} = generate(source, law);
    report.metadata = metadata;
    report.generator_sha256 = hash(readFileSync(new URL('./generate.ts', import.meta.url), 'utf8'));
    report.template_sha256 = hash(readFileSync(new URL('./template.ts', import.meta.url), 'utf8'));
    report.runner_sha256 = hash(readFileSync(new URL('./check.ts', import.meta.url), 'utf8'));
    report.semantic_core_sha256 = hash(readFileSync(new URL('../../semantic/core.ts', import.meta.url), 'utf8'));
    writeFileSync(resolve(directory, 'Generated.lean'), code);
    writeFileSync(resolve(directory, 'metadata.json'), encodeJsonPretty(metadata) + '\n');
    const version = spawnSync(lean, ['--version'], {encoding: 'utf8', timeout: 30000});
    report.tool.version = version.stdout?.trim() ?? null;
    if (version.error || version.status !== 0 || !report.tool.version || !/^Lean \(version 4\.19\.0(?:,|\))/.test(report.tool.version)) throw Error('Pinned Lean 4.19.0 unavailable or mismatched');
    const run = spawnSync(lean, ['Generated.lean'], {cwd: directory, encoding: 'utf8', timeout: 120000});
    log = (run.stdout || '') + (run.stderr || '');
    if (run.error) throw run.error;
    if (run.status !== 0) {
      report.status = 'not_checked';
      throw Error('Lean rejected generated declarations/obligations; see check.log');
    }
    if (/\bsorry\b|\baxiom\s/.test(code)) throw Error('Forbidden proof escape');
    for (const name of ['preserves', 'positive_witness']) {
      const lines = log.split('\n').filter(l => l.startsWith(`'Generated.${name}' `));
      if (lines.length !== 1) throw Error(`Missing/duplicate theorem axiom report: ${name}`);
      const m = lines[0].match(/depends on axioms: \[([^\]]*)\]$/);
      const axioms = m ? m[1].split(',').map(x => x.trim()).filter(Boolean) : lines[0].endsWith('does not depend on any axioms') ? [] : null;
      if (!axioms || axioms.some(a => a !== 'propext')) throw Error('Unrecognized/non-allowlisted theorem axioms');
      report.theorem_axioms[name] = axioms;
    }
    report.status = 'proof_checked';
    report.detail = 'Pinned Lean checked generated invariant and concrete successful witness.';
  } catch (e) {
    if (e instanceof Unsupported) report.status = 'unsupported';
    report.detail = e.message;
  }
  writeFileSync(resolve(directory, 'check.log'), log || report.detail + '\n');
  writeFileSync(resolve(directory, 'report.json'), encodeJsonPretty(report) + '\n');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // JSON declarations can be exported by any domain, including a later inventory fragment.
  const source = process.argv[2] ? decodeJsonObject(readFileSync(process.argv[2], 'utf8')) : model;
  const law = process.argv[3] ? decodeJsonObject(readFileSync(process.argv[3], 'utf8')) : obligation;
  const out = resolve(process.argv[4] || fileURLToPath(new URL('./generated', import.meta.url)));
  const report = check(source, law, out);
  console.log(encodeJsonPretty(report));
  process.exitCode = report.status === 'proof_checked' ? 0 : 1;
}
