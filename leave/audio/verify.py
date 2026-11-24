#!/usr/bin/env python3
"""Independent deliverable checks. Does not judge pronunciation or listening quality."""
import json
import re
from pathlib import Path
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/time-off-audio'

def ff(*args):
    p = subprocess.run(['ffmpeg', '-hide_banner', *map(str, args)], capture_output=True, text=True, check=True)
    return p.stdout + p.stderr

def main():
    manifest = json.loads((OUT / 'manifest.json').read_text())
    duration = manifest['duration']
    assert len(manifest['chapters']) == 17
    for i, chapter in enumerate(manifest['chapters']):
        assert chapter['start'] == i * 6 + 0.35
        assert chapter['end'] <= chapter['next_boundary'] - 0.2
        assert chapter['tempo'] == 1
        with wave.open(str(OUT / f'chapter-{i+1:02}.wav')) as audio:
            assert audio.getnframes() / audio.getframerate() == chapter['duration']
    source = ROOT / 'artifacts/time-off-demo.mp4'
    target = ROOT / 'artifacts/time-off-demo-narrated.mp4'
    def video_hash(path):
        return ff('-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-').strip()
    assert video_hash(source) == video_hash(target) == manifest['video_payload_hash']
    measurements = {}
    for path in [OUT / 'narration.wav', OUT / 'mixed-audio.wav', target]:
        p = subprocess.run(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(path)], check=True, capture_output=True, text=True)
        probe = json.loads(p.stdout)
        assert abs(float(probe['format']['duration']) - duration) < 0.001
        audio = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
        assert abs(float(audio['duration']) - duration) < 0.025
        text = ff('-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-')
        summary = text[text.rfind('Summary:'):]
        integrated = float(re.search(r'I:\s+(-?[\d.]+) LUFS', summary)[1])
        peak = float(re.search(r'Peak:\s+(-?[\d.]+) dBFS', summary)[1])
        assert peak < -0.5, (path, peak)
        if path.name != 'narration.wav':
            assert -16.5 <= integrated <= -15.5
        measurements[path.name] = dict(integrated_lufs=integrated, true_peak_dbfs=peak,
                                       container_duration=float(probe['format']['duration']),
                                       audio_duration=float(audio['duration']), codec=audio['codec_name'])
    report = dict(status='passed', chapters=17, overlap_count=0, truncated_chunks=0,
                  tempo_corrections=0, video_payload_identical=True, measurements=measurements,
                  limits='Automated timing, payload, loudness and peak checks only. No listening or STT audit.')
    (OUT / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()
