import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

// Continuous Chromium recording. Every result follows a real mouse interaction.
// The DOM pointer is necessary because headless browser video omits the OS cursor.
const dir = resolve("artifacts/video-v2");

await mkdir(dir, { recursive: true });

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir, size: { width: 1440, height: 900 } },
});

const page = await context.newPage();
const video = page.video();

type Mark = {
  selector: string;
  caption: string;
  beforeSeconds: number;
  pulseSeconds?: number;
  afterSeconds?: number;
};

const marks: Mark[] = [];

try {
  await page.goto(pathToFileURL(resolve("artifacts/workbench.html")).href);
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `#demo-pointer{position:fixed;left:0;top:0;width:30px;height:38px;z-index:100001;pointer-events:none;filter:drop-shadow(0 2px 2px #0008)}
      #demo-pulse{position:fixed;width:18px;height:18px;border:3px solid #35644e;border-radius:50%;z-index:100000;pointer-events:none;opacity:0;transform:translate(-50%,-50%)}
      #demo-pulse.active{animation:click-pulse .75s ease-out} @keyframes click-pulse{0%{opacity:1;scale:.5;background:#35644e66}70%{opacity:1;scale:3}100%{opacity:0;scale:3.5}}
      .demo-target{outline:3px solid #35644e!important;outline-offset:4px!important}
      #demo-caption{position:fixed;bottom:0;left:0;right:0;padding:14px 28px;background:#252625;color:#fff;font:16px/1.4 Arial,sans-serif;z-index:99999;pointer-events:none;border-top:1px solid #ffffff40}`;
    document.head.append(style);
    const pointer = document.createElement("div");
    pointer.id = "demo-pointer";
    pointer.innerHTML =
      '<svg viewBox="0 0 30 38" aria-hidden="true"><path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 20 L26 19 Z" fill="white" stroke="#252625" stroke-width="2.5" stroke-linejoin="round"/></svg>';
    const pulse = document.createElement("div");
    pulse.id = "demo-pulse";
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    document.body.append(pointer, pulse, caption);
    document.addEventListener("mousemove", (e) => {
      pointer.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    });
    document.addEventListener("pointerdown", (e) => {
      pulse.style.left = e.clientX + "px";
      pulse.style.top = e.clientY + "px";
      pulse.classList.remove("active");
      void pulse.offsetWidth;
      pulse.classList.add("active");
    });
  });
  const started = Date.now();
  let cursor = { x: 1070, y: 120 };
  await page.mouse.move(cursor.x, cursor.y);
  const wait = (ms: number) => page.waitForTimeout(ms); // editorial pacing, not agent polling

  async function caption(text: string) {
    await page
      .locator("#demo-caption")
      .evaluate((el, text) => (el.textContent = text), text);
  }

  async function click(
    selector: string,
    text: string,
    hold = 2100,
    evidence = false
  ) {
    await caption(text);
    const target = page.locator(selector);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();

    if (!box) {
      throw new Error("Invisible target: " + selector);
    }

    const end = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    for (let i = 1; i <= 30; i++) {
      const t = i / 30;
      const eased = t * t * (3 - 2 * t);
      await page.mouse.move(
        cursor.x + (end.x - cursor.x) * eased,
        cursor.y + (end.y - cursor.y) * eased
      );
      await wait(16);
    }

    cursor = end;
    await target.evaluate((el) => {
      el.focus();
      el.classList.add("demo-target");
    });
    await wait(500);

    const mark: Mark = {
      selector,
      caption: text,
      beforeSeconds: (Date.now() - started) / 1000,
    };

    if (evidence) {
      await page.screenshot({ path: resolve(dir, "before-click.png") });
    }

    await page.mouse.down();
    await wait(180);
    mark.pulseSeconds = (Date.now() - started) / 1000;

    if (evidence) {
      await page.screenshot({ path: resolve(dir, "click-pulse.png") });
    }

    await page.mouse.up();
    await wait(650);
    await target.evaluate((el) => el.classList.remove("demo-target"));
    mark.afterSeconds = (Date.now() - started) / 1000;

    if (evidence) {
      await page.screenshot({ path: resolve(dir, "after-click.png") });
    }

    marks.push(mark);
    await wait(hold);
  }

  await caption(
    "Ticket.resolve · edit a rule, then inspect what actually happened."
  );
  await wait(2800);
  await click(
    '[data-for="policy"][data-choice="allow"]',
    "Allow without approval: the same schedule now commits.",
    2200,
    true
  );
  await click(
    "#tab-changes",
    "The policy diff changes exactly one of six decisions.",
    2200
  );
  await click(
    '[data-for="policy"][data-choice="approval"]',
    "Restore the approval requirement.",
    1000
  );
  await click(
    "#tab-execution",
    "Replay the approval → edit → execute schedule.",
    1000
  );
  await click("#restart", "Start with an open ticket and no invocation.", 1000);
  await click("#next", "Request: the policy requires approval.", 1400);
  await click("#next", "Approve: bind approval to this exact subject.", 1600);
  await click(
    "#next",
    "Edit: the arguments no longer match that approval.",
    1800
  );
  await click(
    "#next",
    "Execute: stale approval is rejected. The ticket stays open.",
    2600
  );
  await click(
    "#mutant",
    "Inject a broken approval check: changed arguments incorrectly commit.",
    3000
  );
  await click(
    "#tab-failures",
    "Generated histories independently expose the deliberate fault.",
    1600
  );
  await click(
    '[data-for="property-size"][data-choice="original"]',
    "Inspect the original generated failure.",
    2100
  );
  await click(
    '[data-for="property-size"][data-choice="shrunk"]',
    "A smaller counterexample; bounded shrinking, not global minimality.",
    3000
  );
  await click(
    '[data-for="property-mode"][data-choice="false"]',
    "The same shrunk history agrees with the oracle under the safe interpreter.",
    2500
  );
  await click(
    "#tab-evidence",
    "Evidence has limits: sampled histories and a Lean model, not runtime correspondence.",
    3000
  );
  await writeFile(
    resolve(dir, "interactions.json"),
    JSON.stringify(
      {
        kind: "continuous-browser-video",
        cursor: "DOM pointer tracks actual Playwright mouse; pointerdown pulse",
        timing: "editorial, not execution latency",
        durationBeforeClose: (Date.now() - started) / 1000,
        marks,
      },
      null,
      2
    )
  );
} finally {
  await context.close();
  await browser.close();
}

if (!video) {
  throw Error("Missing workbench recording");
}

const source = await video.path();
const output = resolve("artifacts/semantic-workbench-demo-v2.mp4");

const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    source,
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "19",
    "-preset",
    "medium",
    "-movflags",
    "+faststart",
    output,
  ],
  { encoding: "utf8" }
);

if (result.status !== 0) {
  throw new Error(result.stderr);
}

console.log(`Created ${output} from continuous browser recording ${source}`);
