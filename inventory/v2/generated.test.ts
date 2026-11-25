import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runGenerated, generatedHistory, checkHistory, mutationChecks} from './generated.ts';
import {present} from '../../semantic/test-support.ts';

test('six seeded 30-step SQLite histories predict outcomes and replay exact observations', async () => {
  const report = await runGenerated();
  assert.equal(report.execution, 'executed');
  assert.equal(report.status, 'passed', JSON.stringify(report.cases.flatMap(x => x.counterexample ? [x.counterexample.cause] : [])));
  assert.equal(report.seeds.length, 6);
  assert.equal(report.seeds[0], 0x51a7);
  assert.equal(report.replay.status, 'passed');
  for (const item of report.cases) {
    assert.equal(item.commands.length, 30);
    assert.equal(item.replay?.status, 'passed');
    for (const code of ['unauthorized-approval', 'stale', 'precondition', 'invocation-conflict', 'consumed']) assert.ok(item.observations.some(x => x.result.code === code), `seed ${item.seed}: missing ${code}`);
    for (const action of ['cancel', 'expire', 'delete-terminal']) assert.ok(item.observations.some((x,i) => {
      const command = present(item.commands[i]);
      return x.result.status === 'committed' && command.api === 'execute' && command.command.action === `reservation.${action}`;
    }), `seed ${item.seed}: missing successful ${action}`);
    assert.ok(item.observations.some(x => x.result.status === 'duplicate'));
    assert.equal(checkHistory(item.commands, item.observations).status, 'passed');
  }
  for (const name of ['duplicateDecrementDetected', 'bogusStaleCommitDetected', 'missingExpectedCommitDetected']) {
    assert.equal(report.oracle.mutationChecks[name].detected, true);
    assert.ok(report.oracle.mutationChecks[name].cause.message);
  }
  // Exercise the public checker on altered returned outcomes/state through the
  // same entire history, rather than an isolated arithmetic invariant.
  const {commands, observations} = present(report.cases[0]);
  assert.deepEqual(mutationChecks(commands, observations), report.oracle.mutationChecks);
});

test('seed zero, configurable runs/steps and meaningful deterministic history variation', async () => {
  assert.deepEqual(generatedHistory(0, 40), generatedHistory(0, 40));
  const signature = (seed: number) => generatedHistory(seed).map(x => [x.api, x.api === 'execute' ? x.command.action : undefined, x.api === 'approve' ? undefined : x.command.clock, x.api === 'execute' ? x.command.actor : undefined]);
  assert.notDeepEqual(signature(1), signature(2));
  const report = await runGenerated({seed:0, runs:2, steps:40});
  assert.equal(report.status, 'passed', JSON.stringify(report.cases.flatMap(x => x.counterexample ? [x.counterexample.cause] : [])));
  assert.equal(report.cases.length, 2); assert.equal(present(report.cases[0]).commands.length, 40);
  assert.throws(() => generatedHistory(0, 29), /at least 30/);
  await assert.rejects(runGenerated({runs:0}), /positive/);
});

test('seed-specific counterexample persists actual cause/full prefix and CLI replays it', async () => {
  const dir = await mkdtemp('/tmp/opencode/v2-generated-test-'), reportPath = join(dir, 'failure.json');
  // An expected successful reserve has a deliberately missing observation field.
  // First verify checker reports the missing expected commit at its exact prefix.
  const baseline = await runGenerated({seed:7, runs:1});
  const item = present(baseline.cases[0]), index = item.observations.findIndex(x => x.result.status === 'committed');
  const altered = structuredClone(item.observations); present(altered[index]).result = {status:'rejected', code:'precondition'};
  const failure = checkHistory(item.commands, altered);
  assert.equal(failure.status, 'counterexample'); assert.equal(failure.index, index);
  assert.match(failure.cause.message, /expected committed/);
  assert.deepEqual(failure.failingPrefix, item.commands.slice(0, index + 1));
  // Invalid durable input tests the execution-error path without changing core or
  // adapters. It must write a counterexample report, not only throw an assertion.
  const commands = structuredClone(item.commands.slice(0, 2));
  commands.push({api:'resume', command:{id:'bad-clock', invocationId:'missing', clock:-1}});
  const report = await runGenerated({reportPath, histories:[{seed:7, commands}]});
  assert.equal(report.status, 'counterexample');
  const saved = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(saved.cases[0].counterexample.index, 2);
  assert.match(saved.cases[0].counterexample.cause.message, /nonnegative safe clock/);
  assert.deepEqual(saved.cases[0].counterexample.failingPrefix, commands);
  const cli = spawnSync(process.execPath, ['inventory/v2/generated.ts', '--replay', reportPath, '--report', join(dir, 'replay.json')], {encoding:'utf8'});
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'counterexample');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'replay.json'), 'utf8')).cases[0].counterexample.failingPrefix, commands);
});

test('CLI seed/runs/steps report can be replayed directly into fresh SQLite', async () => {
  const dir = await mkdtemp('/tmp/opencode/v2-generated-cli-'), path = join(dir, 'report.json');
  const cli = spawnSync(process.execPath, ['inventory/v2/generated.ts', '--seed', '0xc0ffee', '--runs', '1', '--steps', '32', '--report', path], {encoding:'utf8'});
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  const report = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(report.cases[0].commands.length, 32);
  const replayPath = join(dir, 'replayed.json');
  const replay = spawnSync(process.execPath, ['inventory/v2/generated.ts', '--replay', path, '--report', replayPath], {encoding:'utf8'});
  assert.equal(replay.status, 0, replay.stderr + replay.stdout);
  assert.deepEqual(JSON.parse(await readFile(replayPath, 'utf8')).cases[0].observations, report.cases[0].observations);
});
