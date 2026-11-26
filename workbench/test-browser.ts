import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type { AxeResults, RunOptions } from "axe-core";
import { chromium } from "playwright";
import type { Page } from "playwright";

import type { Decision, Priority, Role, Ticket } from "../prototype/model.ts";
import { replayHistory } from "../prototype/property.ts";
import type { Action } from "../prototype/property.ts";

declare global {
  interface Window {
    axe?: {
      run: (document: Document, options: RunOptions) => Promise<AxeResults>;
    };
  }
}

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

async function scanAccessibility(page: Page) {
  if (!(await page.evaluate(() => !!window.axe))) {
    await page.addScriptTag({ path: axePath });
  }

  return page.evaluate(() => {
    if (!window.axe) {
      throw new Error("Accessibility audit script was not loaded.");
    }

    return window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
  });
}

const root = fileURLToPath(new URL("../", import.meta.url));
const artifact = resolve(root, "artifacts/workbench.html");
const html = await readFile(artifact, "utf-8");

const payload = html.match(
  /<script id="workbench-data" type="application\/json">([\s\S]*?)<\/script>/u
)?.[1];

assert.ok(payload);

type Schedule = ("approve" | "edit" | "execute")[];

interface Example {
  sampleSeed: number;
  originalHistory: Action[];
  minimalHistory: Action[];
  recordings: Record<
    "original" | "shrunk",
    Record<"true" | "false", ReturnType<typeof replayHistory>[]>
  >;
}

interface WorkbenchData {
  cases: Record<
    string,
    {
      inputs: {
        decision: Decision;
        role: Role;
        priority: Priority;
        schedule: Schedule;
        mutant: boolean;
      };
      frames: { ticket: Ticket; events: unknown[]; deliveries: unknown[] }[];
      violations: string[];
      trace: unknown;
    }
  >;
  schedules: Schedule[];
  generated: { examples: Example[] };
  reports: Record<
    string,
    { availability: string; path: string; reason?: string; data?: unknown }
  >;
}

const data: WorkbenchData = JSON.parse(payload);
const inlineArtifact = resolve(root, "artifacts/workbench-inline.html");
const inlineHTML = await readFile(inlineArtifact, "utf-8");

assert.ok(inlineHTML.length < 512_000);

assert.ok(Buffer.byteLength(inlineHTML) < 512_000);

const stylesheet = inlineHTML.match(/<style>([\s\S]*?)<\/style>/u)?.[1];

assert.ok(stylesheet);

assert.ok(!/\dvh|height:100%|#[0-9a-f]{3,8}\b/iu.test(stylesheet));

assert.ok(!/<script[^>]+src=/u.test(inlineHTML));

assert.equal(Object.keys(data.cases).length, 216);

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });

  let page = await context.newPage();

  const errors: string[] = [];
  const network: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) {
      network.push(request.url());
    }
  });
  await page.goto(pathToFileURL(artifact).href);
  assert.match(
    (await page.locator("#outcome-title").textContent()) ?? "",
    /stale-approval/u
  );
  await page.locator("#mutant").check();
  assert.match(
    (await page.locator("#outcome-title").textContent()) ?? "",
    /counterexample/u
  );
  assert.equal(
    await page.locator("#delivery-count").textContent(),
    "2 intents"
  );
  await page.locator('[data-event="e4"]').click();
  await page
    .locator("#causal")
    .locator("..")
    .locator("summary")
    .first()
    .click();
  assert.match(
    (await page.locator("#causal").textContent()) ?? "",
    /committed/u
  );
  await page.locator("#causal summary").click();
  assert.match(
    (await page.locator("#causal pre").textContent()) ?? "",
    /"approvalMatches": false/u
  );
  await page.locator("#back").click();
  assert.equal(
    await page.locator("#delivery-count").textContent(),
    "0 intents"
  );
  await page.locator("#next").click();
  await page.locator("#restart").click();
  assert.equal(await page.locator(".event").count(), 0);
  await page.locator("#next").click();
  assert.equal(await page.locator(".event").count(), 1);
  await page.locator("#scrub").focus();
  await page.keyboard.press("End");
  assert.match(
    (await page.locator("#counter").textContent()) ?? "",
    /^4 \/ 4/u
  );
  await page.locator("#play").click();
  assert.equal(await page.locator("#play").textContent(), "Pause replay");
  await page.waitForFunction(
    () => document.querySelector("#play")?.textContent === "Play replay",
    undefined,
    { timeout: 10_000 }
  );
  assert.match(
    (await page.locator("#counter").textContent()) ?? "",
    /^4 \/ 4/u
  );
  await page.locator("#play").click();
  await page.locator("#play").click();
  assert.equal(await page.locator("#play").textContent(), "Play replay");
  await page.locator("#reset").click();

  async function propertyChecks() {
    await page.locator("#tab-failures").click();
    assert.equal(
      await page.locator("#property-history option").count(),
      data.generated.examples.length
    );

    for (const [index, example] of data.generated.examples.entries()) {
      await page.locator("#property-history").selectOption(String(index));
      assert.match(
        (await page.locator("#property-meta").textContent()) ?? "",
        new RegExp(String(example.sampleSeed))
      );
      assert.match(
        (await page.locator("#property-meta").textContent()) ?? "",
        new RegExp(
          `original ${example.originalHistory.length} → shrunk ${
            example.minimalHistory.length
          }`
        )
      );

      for (const size of ["original", "shrunk"] as const) {
        await page
          .locator(`[data-for="property-size"][data-choice="${size}"]`)
          .click();

        for (const mode of ["true", "false"] as const) {
          await page
            .locator(`[data-for="property-mode"][data-choice="${mode}"]`)
            .click();
          assert.match(
            (await page.locator("#property-result").textContent()) ?? "",
            mode === "true" ? /counterexample/u : /sampled_pass/u
          );
          await page.locator("#property-replay").click();
          assert.match(
            (await page.locator("#property-result").textContent()) ?? "",
            /step 0/u
          );
          await page.locator("#property-next").click();
          assert.match(
            (await page.locator("#property-result").textContent()) ?? "",
            /step 1/u
          );
          await page.locator("#property-step").focus();
          await page.keyboard.press("End");
          const expected = example.recordings[size][mode].at(-1);

          const inspection = await page
            .locator("#property-inspection")
            .textContent();

          assert.ok(inspection);
          assert.deepEqual(JSON.parse(inspection), expected);
          const downloadEvent = page.waitForEvent("download");
          await page.locator("#property-export").click();

          const replay = JSON.parse(
            await readFile(await (await downloadEvent).path(), "utf-8")
          );

          assert.deepEqual(
            replay.history,
            size === "original"
              ? example.originalHistory
              : example.minimalHistory
          );
          assert.equal(replay.staleApprovalMutant, mode === "true");
          assert.deepEqual(replayHistory(replay), expected);
        }
      }
    }
  }

  await propertyChecks();
  await page.locator("#tab-execution").click();
  assert.equal(await page.locator("#mutant").isChecked(), false);

  // Exercise every browser-selectable combination against its actual captured runtime output.
  for (const c of Object.values(data.cases)) {
    const i = c.inputs;
    await page
      .locator(`[data-for="policy"][data-choice="${i.decision}"]`)
      .click();
    await page.locator("#role").selectOption(i.role);
    await page.locator("#priority").selectOption(i.priority);
    await page
      .locator("#schedule")
      .selectOption(
        String(
          data.schedules.findIndex((s) => s.join(",") === i.schedule.join(","))
        )
      );
    await page.locator("#mutant").setChecked(i.mutant);
    const final = c.frames.at(-1);
    assert.ok(final);
    assert.equal(await page.locator(".event").count(), final.events.length);
    assert.equal(
      await page.locator("#delivery-count").textContent(),
      `${final.deliveries.length} intents`
    );
    const state = await page.locator("#state").textContent();
    assert.ok(state?.includes(final.ticket.status));

    if (c.violations.length) {
      assert.match(
        (await page.locator("#outcome-title").textContent()) ?? "",
        /counterexample/u
      );
    }
  }

  await page.locator("#reset").click();
  await page.locator('[data-for="policy"][data-choice="allow"]').click();
  assert.match(
    (await page.locator("#diff").textContent()) ?? "",
    /approval.*allow/su
  );
  assert.match(
    (await page.locator("#outcome-title").textContent()) ?? "",
    /committed/u
  );
  await page.locator("#priority").selectOption("normal");
  await page.locator("#role").selectOption("viewer");
  assert.match(
    (await page.locator("#outcome-title").textContent()) ?? "",
    /rejected/u
  );
  await page.locator("#reset").click();
  await page.locator("#tab-evidence").click();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadEvent;

  const explanation = JSON.parse(
    await readFile(await download.path(), "utf-8")
  );

  assert.equal(explanation.kind, "simulated");
  const control = data.cases["approval|support|high|0|false"];
  assert.ok(control);
  assert.deepEqual(explanation.trace, control.trace);
  assert.equal(explanation.policyDiff.cases, 6);
  const propertyReport = data.reports["property"];
  assert.ok(propertyReport);
  assert.equal(
    explanation.reports.property.availability,
    propertyReport.availability
  );
  await page.locator("#tab-execution").click();
  await page.locator("#tab-execution").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-changes").getAttribute("aria-selected"),
    "true"
  );
  assert.equal(await page.locator("#panel-execution").isVisible(), false);
  assert.equal(await page.locator("#diff").isVisible(), true);
  await page.locator("#tab-execution").click();
  const desktopAxe = await scanAccessibility(page);
  assert.deepEqual(
    desktopAxe.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
    []
  );

  for (const panel of ["changes", "failures", "evidence"]) {
    await page.locator(`#tab-${panel}`).click();
    const scan = await scanAccessibility(page);
    assert.deepEqual(
      scan.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
      `desktop ${panel}`
    );
  }

  await page.locator("#tab-execution").click();
  await mkdir("/tmp/opencode/workbench-checks", { recursive: true });
  await page.screenshot({
    path: "/tmp/opencode/workbench-checks/desktop.png",
    fullPage: true,
  });

  for (const width of [1100, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true,
      `overflow at ${width}`
    );
  }

  const mobileAxe = await scanAccessibility(page);
  assert.deepEqual(
    mobileAxe.violations.map((v) => v.id),
    []
  );

  for (const panel of ["changes", "failures", "evidence"]) {
    await page.locator(`#tab-${panel}`).click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true,
      `mobile ${panel} overflow`
    );
    const scan = await scanAccessibility(page);
    assert.deepEqual(
      scan.violations.map((v) => v.id),
      [],
      `mobile ${panel}`
    );
  }

  await page.locator("#tab-execution").click();
  await page.screenshot({
    path: "/tmp/opencode/workbench-checks/mobile.png",
    fullPage: true,
  });
  // Missing and unfamiliar report formats must never become inferred passing evidence.
  const missingData = structuredClone(data);
  missingData.reports["property"] = {
    availability: "unavailable",
    path: "artifacts/property-report.json",
    reason: "Not present at build time.",
  };
  missingData.reports["lean"] = {
    availability: "available",
    path: "artifacts/lean-report.json",
    data: { novel_schema: "opaque" },
  };
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    html.replace(
      /(<script id="workbench-data" type="application\/json">)[\s\S]*?(<\/script>)/u,
      (_, before, after) =>
        before + JSON.stringify(missingData).replaceAll("<", "\\u003c") + after
    )
  );
  assert.match(
    (await page.locator("#reports").textContent()) ?? "",
    /Unavailable/u
  );
  assert.match(
    (await page.locator("#reports").textContent()) ?? "",
    /Report attached · inspect below/u
  );
  await page.goto(pathToFileURL(inlineArtifact).href);
  await page.waitForFunction(() =>
    document
      .querySelector("#property-result")
      ?.textContent?.includes("counterexample")
  );
  // Simulate the T3 host theme; inline CSS itself must never install fixed colors.
  await page.addStyleTag({
    content:
      ":root{--background:#ffffff;--foreground:#172033;--muted:#4c566a;--card:#ffffff;--border:#b6c0ce;--primary:#2549a1;--success:#176557;--destructive:#a12639;--warning:#775000;--font-sans:system-ui;--font-mono:monospace}",
  });
  await propertyChecks();
  await page.locator("#tab-execution").click();
  await page.locator("#mutant").check();
  assert.match(
    (await page.locator("#outcome-title").textContent()) ?? "",
    /counterexample/u
  );
  await page.locator('[data-for="policy"][data-choice="deny"]').click();
  assert.match(
    (await page.locator("#outcome-title").textContent()) ?? "",
    /rejected/u
  );
  await page.locator("#reset").click();

  for (const width of [728, 390]) {
    await page.setViewportSize({ width, height: 844 });

    const layout = await page.evaluate(() => {
      const find = (selector: string) => {
        const element = document.querySelector(selector);

        if (!element) {
          throw new Error(`Missing element: ${selector}`);
        }

        return element;
      };

      const style = getComputedStyle(find(".workspace"));

      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        backgrounds: ["html", "body", ".workspace"].map(
          (s) => getComputedStyle(find(s)).backgroundColor
        ),
        outerPadding: style.padding,
        outerBorder: style.borderWidth,
        left: find(".left").getBoundingClientRect().left,
      };
    });

    assert.equal(layout.overflow, false, `inline overflow at ${width}`);
    assert.deepEqual(layout.backgrounds, Array(3).fill("rgba(0, 0, 0, 0)"));
    assert.equal(layout.outerPadding, "0px");
    assert.equal(layout.outerBorder, "0px");
    assert.equal(layout.left, 0);
    const axe = await scanAccessibility(page);
    assert.deepEqual(
      axe.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      []
    );

    for (const panel of ["changes", "failures", "evidence"]) {
      await page.locator(`#tab-${panel}`).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        ),
        true,
        `inline ${width} ${panel} overflow`
      );
      const scan = await scanAccessibility(page);
      assert.deepEqual(
        scan.violations.map((v) => v.id),
        [],
        `inline ${width} ${panel}`
      );
    }

    await page.locator("#tab-execution").click();
    await page.screenshot({
      path: `/tmp/opencode/workbench-checks/inline-${width}.png`,
      fullPage: true,
    });
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log(
    "PASS: 216 UI execution combinations; safe/mutant divergence; causal details; policy diff; replay transport/play/pause/scrub; JSON download; optional/unknown reports; 4 responsive widths; zero browser errors or network requests; desktop/mobile axe WCAG A/AA scans (0 violations)."
  );
  console.log(
    "Screenshots: /tmp/opencode/workbench-checks/{desktop,mobile}.png"
  );
  console.log(
    `PASS: generated original/shrunk histories, seed/count metadata, safe/mutant API replay and export on both artifacts; inline ${inlineHTML.length} characters / ${Buffer.byteLength(inlineHTML)} bytes; transparent edge-to-edge layout; keyboard tabs and all four panels scanned with axe on desktop/mobile and inline 728/390.`
  );
} finally {
  await browser.close();
}
