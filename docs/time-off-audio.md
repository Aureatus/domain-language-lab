# Time-off demo: Freya narration and music

Deliverable: [`artifacts/time-off-demo-narrated.mp4`](../artifacts/time-off-demo-narrated.mp4), **102.04 seconds**, original 1440×1080/25 fps H.264 stream copied unchanged, with stereo 48 kHz AAC audio. The original `artifacts/time-off-demo.mp4` and application runtime are untouched. Existing visual captions remain unchanged; the spoken script is shortened for the scenes.

## Audio and sources

- **Actual local Phonon synthesis**, not a substitute voice or ASR model. “2 Freya” means British English female catalogue entry #2, **Freya**, voice ID `GgfEkEJtxZR7gnpy`.
- **Model:** [`gradium/phonon-31m-en`](https://huggingface.co/gradium/phonon-31m-en/tree/92741c5b07d085ff840e26fea8ce43110b87852f), revision `92741c5b07d085ff840e26fea8ce43110b87852f`, f32 `model.safetensors`, Apache-2.0.
- **Voice:** [`gradium/phonon-voices`](https://huggingface.co/gradium/phonon-voices/tree/0ee17205f254b5abc43b266c8a0f215565c352f7), revision `0ee17205f254b5abc43b266c8a0f215565c352f7`, `voices/GgfEkEJtxZR7gnpy.safetensors`, Apache-2.0. The repository README identifies Freya and the licence; snapshots are included beside the outputs.
- **Runtime:** official [`ptts` v0.7.1](https://github.com/gradium-ai/xn-ptts/releases/tag/v0.7.1), release tag resolves to source commit `5f9522b3e245846d312caaeb460d3dcae5d1a991`. Linux x86-64 binary archive verified against the publisher’s `SHA256SUMS`; archive SHA-256 `4e65eb2028f85565b69d7a7e6d88eef32a38b28d77860d2c75427e33163f4bbf`. CPU, four threads, temperature 0.3, seed 4242424242424242, default speaking rate. Installed only under `/tmp/opencode/time-off-phonon`; model files use the runtime’s ordinary Hugging Face cache. No global package installation.
- **Music:** a real download of [“Carefree” from Kevin MacLeod’s official site](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037), ISRC `USUAN1400037`. Ukulele, guitar, marimba, glockenspiel and percussion; official catalogue describes it as bright, calming and uplifting. The official track-page source explicitly grants **CC BY 4.0**. The original MP3, catalogue, and license-page HTML are retained. No authentication or paywall bypass.

### Required music credit

> Carefree by Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0. https://creativecommons.org/licenses/by/4.0/

Music modified: first 102.04 seconds, gain changes, voice-driven ducking, two-second fade-in and four-second fade-out. Credit is also in `ATTRIBUTION.txt`, the manifest, mixed WAV metadata and MP4 comment metadata. Keep this attribution with redistributed video; include it in the post description when posting to services that strip metadata.

## Outputs and reproduction

All audio assets are in [`artifacts/time-off-audio/`](../artifacts/time-off-audio/):

- `narration.wav`: complete, scene-aligned mono 48 kHz/24-bit narration, 102.04 seconds.
- `mixed-audio.wav`: stereo 48 kHz/24-bit final master, 102.04 seconds.
- `chapter-01.wav` through `chapter-17.wav`: uncut, native 24 kHz Freya chunks, plus synthesis logs.
- `manifest.json`: exact spoken text, starts/ends/durations, source revisions, source hashes, original-video hash and FFprobe output.
- `verification.json`, `ffprobe.json`, loudness and mastering logs: executed measurement evidence.
- `narration-raw.wav` and `mix-premaster.wav`: intermediate reproduction material.

Run from the repository root on Linux x86-64-v3 with Python 3.14 (standard library), FFmpeg and FFprobe:

```sh
python3 leave/audio/build.py
python3 leave/audio/verify.py
```

Executed with Python 3.14.2, `ptts 0.7.1`, FFmpeg `6.1.1-3ubuntu5`. The script downloads the official runtime, pinned voice/model and music, synthesizes locally, and exports the video. Voice/music content hashes are enforced; the runtime archive checksum is verified. Re-execution replaces **only the new audio outputs and narrated MP4**, not the original video. External download availability and numerical consistency across other hardware remain dependencies.

## Timing and mix

The 17 chapter anchors come from `artifacts/time-off-video.json` at 0, 6, …, 96 seconds. Speech begins 0.35 seconds after each anchor. Each chunk lasts **3.52–5.12 seconds**, with at least 0.53 seconds left before the next scene; the final utterance ends at 100.83 seconds. **No overlaps, tempo corrections or truncated speech.** Full chunk durations, including their model-generated pauses, are preserved. Silence fills the gaps.

Narration is normalized to −18 LUFS/−3 dBTP. Music is normalized, reduced further, and sidechain-compressed by the narration (6:1 ratio, 15 ms attack, 500 ms release). Two-pass final loudness mastering targets −16 LUFS and −1.5 dBTP. Sample-count padding restores the exact duration after resampling; it affects trailing silence, not utterances.

## Executed verification and limits

`python3 leave/audio/verify.py` passed:

- 17 scene slots, zero overlapping/truncated chunks, all tempo factors 1.
- Original and narrated **compressed video payload SHA-256 identical**; the build also checks that the original file’s SHA-256 did not change.
- Narration WAV, mixed WAV, video container and AAC audio stream are each **102.04 seconds**.
- Narration: **−18.0 LUFS**, **−3.0 dBTP**.
- Mixed WAV and decoded final AAC: **−16.0 LUFS**, **−1.5 dBTP**; measured peaks below clipping. Final measured loudness range: approximately **7.1 LU**.

These checks establish timing, stream preservation and measured signal levels, **not perceptual intelligibility or pronunciation quality**. No listening-capable tool was available in this execution; no listening review or speech-recognition transcript audit is claimed. The music selection is an editorial choice based on its official description/instrumentation, not a claimed listening assessment.

Read depth: local README, full time-off demo memo and chapter manifest; selected official Phonon launch article, runtime README/CLI guide and release metadata, voice catalogue rows/licence, and artist catalogue/track-page source. Independent execution of actual Phonon generation, FFmpeg mix/mux and verification. No application or semantic guarantee changed.
