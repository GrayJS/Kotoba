"""Download three public JSUT test clips, outside the distributed application."""
import json
from pathlib import Path
from urllib.request import urlretrieve
import wave
import numpy as np
import soxr
from faster_whisper.audio import decode_audio
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'build' / 'speech-test'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://huggingface.co/datasets/FluidInference/JSUT-basic5000/resolve/main/'
clips = []
for index in (1, 2, 3):
    name = f'BASIC5000_{index:04d}.wav'
    file = OUT / name
    if not file.exists():
        urlretrieve(BASE + 'basic5000/' + name, file)
    clips.append(decode_audio(str(file)))
urlretrieve(BASE + 'LICENCE.txt', OUT / 'JSUT-LICENCE.txt')
samples = [np.zeros(16000, dtype=np.float32)]
for clip in clips:
    samples.extend((clip * 0.35, np.zeros(24000, dtype=np.float32)))
audio = soxr.resample(np.concatenate(samples), 16000, 48000)
pcm = np.repeat((audio * 32767).astype('<i2')[:, None], 2, axis=1)
with wave.open(str(OUT / 'japanese-playback.wav'), 'wb') as wav:
    wav.setparams((2, 2, 48000, 0, 'NONE', 'not compressed')); wav.writeframes(pcm.tobytes())
(OUT / 'source.json').write_text(json.dumps({'source': BASE, 'clips': [f'BASIC5000_{i:04d}.wav' for i in (1,2,3)], 'seconds': len(audio)/48000}, indent=2))
print(json.dumps({'fixture': str(OUT / 'japanese-playback.wav'), 'seconds': len(audio)/48000}))
