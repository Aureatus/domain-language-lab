# Semantic workbench

Build from the repository root with Node 22.18+:

```sh
node workbench/build.ts
```

Open `artifacts/workbench.html` directly. No server, network requests, packages, fonts or CDN are needed. Native Node TypeScript stripping is not static type checking.

`artifacts/workbench-inline.html` is the compact, self-contained embedding variant (build fails at 512000 characters). It retains all 216 cases, reports, generated histories and meaningful controls using gzip/base64 data and the browser’s native `DecompressionStream`; all scripts are inline and decoding makes no network requests. It requires a modern browser with that API. Its transparent html/body/workspace, zero outer padding/border, absent banner/title and content-driven height are designed for host embedding at 728/390 widths. Colors and fonts use host theme variables (`--background`, `--foreground`, `--muted`, `--card`, `--border`, `--primary`, `--success`, `--destructive`, `--warning`, `--font-sans`, `--font-mono`); the host must supply them. Both variants use the redesigned workspace; `workbench/workspace.css` is the canonical structural and standalone stylesheet, with host overrides in `workbench/inline.css`.

## Workspace layout

The primary job is to edit the support/high approval rule, then inspect its execution. A narrow control pane and one working surface replace the previous three-column dashboard. Neutral gray/white surfaces, Arial/system sans-serif and a restrained green accent keep attention on the actual rule and result; red is reserved for faults. There is no marketing hero, serif headline or decorative card grid.

Execution, policy changes, generated failures and evidence are working tabs with arrow/Home/End keyboard navigation. Causal details and raw reports use disclosure controls. Policy and generated-history mode/size choices use actual accessible button groups with pressed state, rather than native menus that disappear from recorded video. The original finite-case select IDs remain as hidden backing inputs; automation should click the visible `data-for` / `data-choice` buttons. Mobile stacks controls above the working panel, with a horizontally scrollable tab strip. No functionality is removed: schedules, roles, priority, replay, event inspection, relationships, all generated histories and both exports remain available.

The build imports the actual `Runtime`, `model`, `policyDiff`, schedule permutations and explorer. It generates 216 executions: three support/high policy choices, three actor roles, two priorities, six permutations of approve/edit/execute, and safe/mutant interpreters. Each starts with one request; the injected clock is 1000. Frames capture actual state after each operation. Event parent edges come from the interpreter, not layout order. The deliberate mutant accepts a stale approval in approve → edit → execute; the safe interpreter rejects it.

The policy editor changes only support/high. Reset restores the baseline scenario. Other policy cells are read-only. Controls select precomputed executions, not an unrestricted browser runtime. Replay is inert presentation, never command resubmission. Download includes the selected execution, original trace, policy diff, report snapshots, replay selection and simulation bounds.

`artifacts/property-report.json` and `artifacts/lean-report.json` are optional build inputs. Their complete JSON is preserved and inspectable; missing/invalid reports are explicitly unavailable. Result fields are read flexibly without converting unknown schemas into success. Rebuild after reports change. Attached reports concern their own declared artifacts, not every editor variant. Proof evidence does not prove correspondence with the TypeScript interpreter.

## Generated failure inspector

The build separately calls `runProperties` with run seed 24301 (`0x5eed`), 12 samples, maxSteps 16, shrinkBudget 2000 and the deliberate stale-approval mutant. It does not overwrite the normal property report. This is an executed fault-injection demonstration, not an illustrative fixture or a failure of the safe interpreter.

Each discovered failure is selectable by sample and sample seed. The inspector shows original versus shrunk action counts, full action histories, shrink attempts, budget exhaustion and the API’s exact minimality classification. Shrinking only preserves the failure kind under bounded chunk deletion, single deletion and listed value simplifications; **no global minimality is claimed**.

Original/shrunk and safe/mutant selectors choose prefix recordings produced by actual `replayHistory` calls at build time. Restart, next and keyboard-accessible range controls inspect those recordings, including the oracle discrepancy and complete trace. The API stops execution at its first discrepancy, even if a selected original-history prefix extends beyond that point. Safe `sampled_pass` means only that selected prefix agrees with the snapshot oracle, not exhaustive correctness. These histories start from the property API’s baseline model/ticket and fixed clock 1000, independently of the schedule policy editor. Export downloads the full selected history as the exact `approval-property-replay/1` contract accepted by `replayHistory` (not only the visible prefix); the mode is explicit in `staleApprovalMutant`.

## Boundaries

This is an experimental renderer over one ticket and invocation, trusted roles, synchronous in-memory grouped updates, conservative whole-model/ticket approval bindings, and recipient-set delivery intents. No external delivery, authentication, persistence, bidirectional propagation, arbitrary schedules, unrestricted policy programming or end-to-end proof is implemented. Six-decision policy comparison is not behavioral equivalence. Finite schedule exploration remains bounded, and the subject-comparison oracle trusts interpreter trace completeness.

## Browser checks

With Playwright, Chromium and `@axe-core/playwright` available, run:

```sh
node workbench/test-browser.ts
```

The test opens the artifact using `file://`; no preview service is used. It covers all 216 selectable runs, replay/play/pause/keyboard scrubbing, causal inspection, JSON export, report fallbacks, four responsive widths and desktop/mobile axe WCAG A/AA scans. Automated scans are not a complete accessibility audit. Missing tooling is an error, not a passing test.

Install Chromium for the workspace's Playwright dependency:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run test:browser
```

Screenshots are written outside the repository to `/tmp/opencode/workbench-checks/`.

Additional checks exercise every generated failure’s original/shrunk and safe/mutant combinations in both artifacts, compare inspected results and downloaded replay contracts against `replayHistory`, and verify seed/count metadata, restart/next/keyboard scrubbing. Inline checks enforce the size limit, local scripts, absence of fixed CSS colors/viewport heights, transparent edge-to-edge layout, no horizontal overflow and axe scans at 728/390 widths. Read depth: selected source inspection of `prototype/property.ts`, independent execution of the build and Chromium suite; no proof audit or global language guarantee.

## Cursor-visible demo v2

```sh
node workbench/build.ts
node workbench/record-demo.ts
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,pix_fmt,r_frame_rate -of json artifacts/semantic-workbench-demo-v2.mp4
```

The recorder uses Playwright `recordVideo` at 1440×900, then ffmpeg H.264/yuv420p at 30 fps with `+faststart`. It records continuous browser video, **not a slideshow of screenshots**. A large DOM pointer follows the real Playwright mouse through eased movements; pointer-down triggers an animated click pulse, targets receive a focus outline, and pauses precede clicks and follow results. All changes come from actual mouse-down/up interactions. Captions are short; there is no audio. Timing is editorial, not measured interpreter latency.

The sequence shows policy editing and its diff, stepwise stale-approval rejection, deliberately faulty execution, an original generated history shrinking from eight to four actions, safe replay and scoped evidence. `artifacts/video-v2/` contains the original continuous WebM, interaction timestamps (`interactions.json`), and before/pulse/after screenshots. Decoded MP4 frame evidence is stored as `decoded-{before,pulse,after,faulty,original,shrunk,evidence}.png` after manual verification. The latest verified recording is 62.17 seconds, H.264, 1440×900, 30 fps, approximately 1.71 MB; its `moov` atom precedes `mdat` (faststart). Recording duration varies slightly with machine performance.

Verified: 15 Node functional tests; all 216 selectable execution combinations; original/shrunk and safe/mutant histories and replay exports against the API in both artifacts; tab keyboard behavior; zero axe WCAG A/AA violations across all four panels on desktop/mobile and both inline widths. The inline build is 80,533 characters / 80,606 bytes, below 512,000 (the build enforces both limits). Automated scans are not a complete accessibility audit; Chromium was the only browser executed. Evidence reports were inspected/attached, not regenerated or independently proof-audited by the UI work.
