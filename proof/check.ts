import {errorMessage} from '../errors.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'proof');
const artifact = resolve(root, 'artifacts');
mkdirSync(artifact, { recursive: true });
const expected = ['commit_requires_current_binding', 'successful_path_exists', 'stale_approval_cannot_commit'];
const pin = readFileSync(resolve(dir, 'lean-toolchain'), 'utf8').trim().split(':v').at(-1);
const local = resolve(process.env['ELAN_HOME'] || resolve(homedir(), '.elan'), 'bin/lean');
// LEAN is an explicit executable override, never a shell command.
const lean = process.env['LEAN'] || (existsSync(local) ? local : 'lean');
const theoremAxioms:Record<string,string[]>={};
const axiomsReported:string[]=[], trustedAssumptions:string[]=[];
const report = {
  format: 'lean-proof-report/1', status: 'tool_error', source: 'proof/Approval.lean',
  source_sha256: createHash('sha256').update(readFileSync(resolve(dir, 'Approval.lean'))).digest('hex'),
  tool: { name: 'Lean 4', version: 'unavailable' }, axioms_reported: axiomsReported, theorem_axioms: theoremAxioms,
  trusted_assumptions: trustedAssumptions,
  claim: 'In the explicit mathematical transition model, every committing step has current version/argument/policy-bound approval; a successful path exists and a concrete stale binding is rejected.',
  scope: 'Lean model only. TypeScript correspondence, hashing, runtime, transactions and external effects are not proved.',
  log: 'artifacts/lean-proof.log', detail: '',
};
let log = '';
try {
  const version = spawnSync(lean, ['--version'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  if (version.error || version.status !== 0) throw new Error(`Lean version unavailable: ${version.error?.message || version.stderr}`);
  report.tool.version = version.stdout.trim();
  const match = report.tool.version.match(/^Lean \(version ([\d.]+)(?:,|\))/);
  if (!match || match[1] !== pin) throw new Error(`Expected pinned Lean ${pin}, got ${report.tool.version}`);
  const checked = spawnSync(lean, ['Approval.lean'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  log = (checked.stdout || '') + (checked.stderr || '');
  if (checked.error || checked.status !== 0) throw new Error(`Lean check failed: ${checked.error?.message || 'see log'}`);
  // Fail closed: every expected theorem must report its complete transitive axiom set.
  for (const name of expected) {
    const lines = log.split('\n').filter(line => line.startsWith(`'ApprovalPilot.${name}' `));
    if (lines.length !== 1) throw new Error(`Missing/duplicate axiom report for ${name}`);
    const line = lines[0];
    const parsed = line.match(/depends on axioms: \[([^\]]*)\]$/);
    const axioms = parsed ? parsed[1].split(',').map(x => x.trim()).filter(Boolean)
      : line.endsWith('does not depend on any axioms') ? [] : null;
    if (!axioms) throw new Error(`Unrecognized axiom output: ${line}`);
    report.theorem_axioms[name] = axioms;
  }
  report.axioms_reported = [...new Set(Object.values(report.theorem_axioms).flat())].sort();
  if (report.axioms_reported.some(axiom => axiom !== 'propext')) throw new Error('Non-allowlisted theorem axiom');
  report.trusted_assumptions = report.axioms_reported.map(axiom => `Lean core axiom: ${axiom}`);
  report.status = 'proof_checked';
  report.detail = 'Pinned Lean checked declarations; complete printed theorem axiom sets passed the propext-only allowlist.';
} catch (error) { report.detail = errorMessage(error); }
writeFileSync(resolve(artifact, 'lean-proof.log'), log || report.detail + '\n');
writeFileSync(resolve(artifact, 'lean-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'proof_checked' ? 0 : 1;
