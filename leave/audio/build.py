#!/usr/bin/env python3
"""Pinned local Phonon/Freya synthesis and scene-aligned FFmpeg mix. No pip needed."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/time-off-audio'
TOOLS = Path('/tmp/opencode/time-off-phonon')
MODEL = '92741c5b07d085ff840e26fea8ce43110b87852f'
VOICES = '0ee17205f254b5abc43b266c8a0f215565c352f7'
VOICE = 'GgfEkEJtxZR7gnpy'
VERSION = '0.7.1'
ARCHIVE = f'ptts-{VERSION}-x86_64-unknown-linux-gnu'
CREDIT = 'Carefree by Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0. https://creativecommons.org/licenses/by/4.0/'
TEXTS = [
    'Meet Maya. Five days of leave, and a Friday to herself.',
    'Just one weekday. The current rule approves it automatically.',
    'Friday is booked. Maya has four days left.',
    'Next, a longer break. Monday to Wednesday: three weekdays.',
    'This needs Sam\'s approval. Her four days stay untouched.',
    'Sam sees Maya\'s dates, requested days, and available balance.',
    'Sam saves his approval, then completes the original request.',
    'Maya now has one day left. Both views update live.',
    'Now Leo wants Thursday and Friday. He has five days.',
    'For now, two days qualify automatically. Nothing is submitted yet.',
    'Sam changes the live rule: approval for two days or more.',
    'Same dates, new rule. Leo now needs Sam\'s approval.',
    'Leo sends his request. His balance stays at five.',
    'Sam approves. Leo\'s other view updates to three days.',
    'One shared action records leave and deducts the days together.',
    'Reopen the database. Both balances and the rule are saved.',
    'Request a break. See what happens. Share the saved outcome.',
]

def run(args, log=None):
    p = subprocess.run([str(a) for a in args], check=True, capture_output=True, text=True)
    if log:
        Path(log).write_text(p.stdout + p.stderr)
    return p.stdout + p.stderr

def download(url, dest):
    if not dest.exists():
        urllib.request.urlretrieve(url, dest)

def sha(path):
    return hashlib.file_digest(open(path, 'rb'), 'sha256').hexdigest()

def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    TOOLS.mkdir(parents=True, exist_ok=True)
    release = f'https://github.com/gradium-ai/xn-ptts/releases/download/v{VERSION}'
    archive = TOOLS / 'ptts.tar.gz'
    download(f'{release}/{ARCHIVE}.tar.gz', archive)
    download(f'{release}/SHA256SUMS', TOOLS / 'SHA256SUMS')
    assert f'{sha(archive)}  {ARCHIVE}.tar.gz' in (TOOLS / 'SHA256SUMS').read_text()
    if not (TOOLS / ARCHIVE / 'ptts').exists():
        with tarfile.open(archive) as tar:
            tar.extractall(TOOLS, filter='data')
    voice = OUT / 'freya.safetensors'
    voice_url = f'https://huggingface.co/gradium/phonon-voices/resolve/{VOICES}/voices/{VOICE}.safetensors'
    download(voice_url, voice)
    assert sha(voice) == 'eb3cd47418349e618408c16bea7153988b3ad04b41a6033039dd474a9a4dcd23'
    music = OUT / 'Carefree.mp3'
    music_url = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3'
    download(music_url, music)
    assert sha(music) == '8433b770a630d9b1594fd484442c677907ece899a4d149954cd2e74fd733e311'
    download(f'https://huggingface.co/gradium/phonon-31m-en/raw/{MODEL}/README.md', OUT / 'model-README.md')
    download(f'https://huggingface.co/gradium/phonon-voices/raw/{VOICES}/README.md', OUT / 'voices-README.md')
    download('https://incompetech.com/music/royalty-free/pieces.json', OUT / 'music-catalog.json')
    download('https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037', OUT / 'music-license-page.html')
    source = ROOT / 'artifacts/time-off-demo.mp4'
    original_hash = sha(source)
    original_probe = probe(source)
    duration = float(original_probe['format']['duration'])
    chapters = json.loads((ROOT / 'artifacts/time-off-video.json').read_text())['chapters']
    entries = []
    for i, (chapter, text) in enumerate(zip(chapters, TEXTS, strict=True)):
        raw = OUT / f'chapter-{i+1:02}.wav'
        cmd = [TOOLS / ARCHIVE / 'ptts', '--model', f'hf://gradium/phonon-31m-en@{MODEL}',
               '--voice', voice, '--lang', 'en', '--device', 'cpu', '--threads', '4',
               '--seed', '4242424242424242', '--temperature', '0.3', text, '-o', raw]
        run(cmd, OUT / f'chapter-{i+1:02}.log')
        with wave.open(str(raw)) as wav:
            seconds = wav.getnframes() / wav.getframerate()
        start = chapter['second'] + 0.35
        end = start + seconds
        boundary = chapters[i+1]['second'] if i+1 < len(chapters) else duration
        if end > boundary - 0.2:
            raise RuntimeError(f'Chapter {i+1} is too long ({seconds}s); shorten text, never truncate')
        entries.append(dict(index=i+1, title=chapter['title'], text=text, start=start,
                            duration=seconds, end=end, next_boundary=boundary,
                            tempo=1, sha256=sha(raw)))
        print(f'{i+1:02}: {start:.2f}–{end:.2f} ({seconds:.2f}s)', flush=True)
    # Assemble complete WAV with explicit silent gaps, without cutting or speeding any voice.
    narration_raw = OUT / 'narration-raw.wav'
    with wave.open(str(narration_raw), 'wb') as dest:
        dest.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
        position = 0
        for entry in entries:
            offset = round(entry['start'] * 24000)
            dest.writeframes(b'\0\0' * (offset - position))
            with wave.open(str(OUT / f"chapter-{entry['index']:02}.wav")) as chunk:
                assert chunk.getnchannels() == 1 and chunk.getsampwidth() == 2 and chunk.getframerate() == 24000
                frames = chunk.readframes(chunk.getnframes())
            dest.writeframes(frames)
            position = offset + len(frames)//2
        dest.writeframes(b'\0\0' * (round(duration * 24000) - position))
    narration = OUT / 'narration.wav'
    run(['ffmpeg', '-y', '-i', narration_raw, '-af', 'loudnorm=I=-18:TP=-3:LRA=7', '-ar', '48000', '-c:a', 'pcm_s24le', narration], OUT / 'narration-normalize.log')
    mix_raw = OUT / 'mix-premaster.wav'
    graph = (f'[0:a]asplit=2[n][key];[1:a]atrim=duration={duration},asetpts=PTS-STARTPTS,'
             'loudnorm=I=-23:TP=-5:LRA=7,volume=0.32,afade=t=in:d=2,'
             f'afade=t=out:st={duration-4}:d=4[m];'
             '[m][key]sidechaincompress=threshold=0.015:ratio=6:attack=15:release=500:makeup=1[duck];'
             '[n][duck]amix=inputs=2:duration=first:normalize=0[out]')
    run(['ffmpeg', '-y', '-i', narration, '-i', music, '-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', mix_raw], OUT / 'mix.log')
    # Two-pass final mastering. Output JSON is retained as measured evidence.
    analysis = run(['ffmpeg', '-i', mix_raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json', '-f', 'null', '-'], OUT / 'master-pass1.log')
    measured = json.loads(analysis[analysis.rfind('{'):analysis.rfind('}')+1])
    filt = 'loudnorm=I=-16:TP=-1.5:LRA=7:linear=true:print_format=json:' + ':'.join(
        f'{key}={measured[value]}' for key, value in [('measured_I','input_i'), ('measured_TP','input_tp'), ('measured_LRA','input_lra'), ('measured_thresh','input_thresh'), ('offset','target_offset')])
    # Resampling in loudnorm can shorten trailing silence by a few milliseconds.
    # Restore the exact timeline, not speech: every utterance ends before 100.84s.
    filt += f',aresample=48000,asetpts=N/SR/TB,apad,atrim=end_sample={round(duration*48000)}'
    mixed = OUT / 'mixed-audio.wav'
    run(['ffmpeg', '-y', '-i', mix_raw, '-af', filt, '-ar', '48000', '-c:a', 'pcm_s24le', '-metadata', f'comment={CREDIT}', mixed], OUT / 'master-pass2.log')
    target = ROOT / 'artifacts/time-off-demo-narrated.mp4'
    run(['ffmpeg', '-y', '-i', source, '-i', mixed, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-t', str(duration), '-metadata', f'comment={CREDIT} Narration: Gradium Phonon 31m, Freya.', '-movflags', '+faststart', target], OUT / 'mux.log')
    assert sha(source) == original_hash
    for path in [mixed, target]:
        run(['ffmpeg', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], OUT / f'{path.stem}-loudness.log')
    final_probe = probe(target)
    assert float(final_probe['format']['duration']) == duration
    # Compare compressed video payloads, not just codec labels.
    def video_hash(path):
        return run(['ffmpeg', '-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).strip()
    assert video_hash(source) == video_hash(target)
    manifest = dict(duration=duration, chapters=entries, source_video_sha256=original_hash,
                    video_payload_hash=video_hash(source), runtime_version=run([TOOLS / ARCHIVE / 'ptts', '--version']).strip(),
                    runtime_archive_sha256=sha(archive), model=dict(repo='gradium/phonon-31m-en', revision=MODEL, weights='model.safetensors', quantization='f32', license='Apache-2.0'),
                    runtime_source_commit='5f9522b3e245846d312caaeb460d3dcae5d1a991',
                    voice=dict(name='Freya', id=VOICE, repo='gradium/phonon-voices', revision=VOICES, url=voice_url, sha256=sha(voice), license='Apache-2.0'),
                    music=dict(title='Carefree', artist='Kevin MacLeod', source=music_url, page='https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400037', license='CC BY 4.0', attribution=CREDIT, sha256=sha(music), edits='first 102.04 seconds; gain, sidechain ducking, fades'),
                    final_probe=final_probe, listening='No audio listening tool available; no listening or STT quality claim.',
                    reproduction='python3 leave/audio/build.py; Linux x86-64-v3, ffmpeg/ffprobe required',
                    ffmpeg=run(['ffmpeg','-version']).splitlines()[0])
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (OUT / 'ATTRIBUTION.txt').write_text(CREDIT + '\nMusic edited for length, gain, ducking and fades.\nNarration generated locally with Gradium Phonon 31m and Freya.\n')
    (OUT / 'ffprobe.json').write_text(json.dumps(final_probe, indent=2) + '\n')

if __name__ == '__main__':
    main()
