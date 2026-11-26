import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const artifacts = new URL("../artifacts/", import.meta.url);
const video = new URL("time-off-code-companion.mp4", artifacts).pathname;

function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  return r.stdout;
}

type Probe = {
  streams: {
    codec_type: string;
    width?: number;
    height?: number;
    codec_name: string;
    r_frame_rate: string;
  }[];
  format: { duration: string };
};

const probe: Probe = JSON.parse(
  run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    video,
  ])
);

const stream = probe.streams.find((s) => s.codec_type === "video");

assert.ok(stream);

assert.equal(stream.width, 1920);

assert.equal(stream.height, 1080);

assert.equal(stream.codec_name, "h264");

assert.equal(
  probe.streams.some((s) => s.codec_type === "audio"),
  false
);

const duration = Number(probe.format.duration);

assert.ok(duration >= 140 && duration <= 160);

const frames: { second: number; path: string }[] = [];

for (const second of [5, 25, 45, 65, 95, 105, 125, 135]) {
  const output = new URL(`time-off-explained-frame-${second}.png`, artifacts)
    .pathname;

  run("ffmpeg", [
    "-y",
    "-ss",
    String(second),
    "-i",
    video,
    "-frames:v",
    "1",
    output,
  ]);
  frames.push({ second, path: output });
}

await writeFile(
  new URL("time-off-explained-media.json", artifacts),
  JSON.stringify(
    {
      video,
      duration,
      width: stream.width,
      height: stream.height,
      codec: stream.codec_name,
      frameRate: stream.r_frame_rate,
      audio: false,
      frames,
      inspection:
        "Frame extraction only; visual inspection must be performed separately.",
    },
    null,
    2
  )
);

console.log(JSON.stringify({ duration, frames }, null, 2));
