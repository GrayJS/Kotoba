"""Exercise real WASAPI isolation using two short, quiet synthetic tone players."""
import json
import os
from pathlib import Path
import subprocess
import time
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'build' / 'capture-test'
OUT.mkdir(parents=True, exist_ok=True)
CSC = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
PLAYERS = []
CAPTURE = None
flags = subprocess.CREATE_NO_WINDOW
try:
    for name, hz in [('tone-a', 440), ('tone-b', 880)]:
        target = OUT / (name + '.exe')
        subprocess.run([str(CSC), '/nologo', '/target:exe', '/out:' + str(target), str(ROOT / 'tests/tone-player.cs')], check=True, creationflags=flags)
        sound = (np.sin(2 * np.pi * hz * np.arange(48000) / 48000) * 1000).astype('<i2')
        file = OUT / (name + '.wav')
        with wave.open(str(file), 'wb') as wav:
            wav.setparams((1, 2, 48000, 0, 'NONE', 'not compressed')); wav.writeframes(sound.tobytes())
        PLAYERS.append(subprocess.Popen([str(target), str(file), '4500'], creationflags=flags))
    time.sleep(.7)
    CAPTURE = subprocess.Popen([str(ROOT / 'build/native/loopback.exe'), '--pid', str(PLAYERS[0].pid), '--parent', str(os.getpid())], stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    raw = CAPTURE.stdout.read(48000 * 4 * 2)
    if len(raw) != 48000 * 4 * 2:
        raise RuntimeError('Capture did not return two seconds of PCM: ' + CAPTURE.stderr.read().decode())
    mono = np.frombuffer(raw, dtype='<i2').reshape(-1, 2).mean(axis=1)
    spectrum = abs(np.fft.rfft(mono * np.hanning(len(mono))))
    frequencies = np.fft.rfftfreq(len(mono), 1 / 48000)
    a = float(spectrum[(frequencies > 435) & (frequencies < 445)].max())
    b = float(spectrum[(frequencies > 875) & (frequencies < 885)].max())
    isolation = float(20 * np.log10(max(a, 1) / max(b, 1)))
    assert np.sqrt(np.mean(mono * mono)) > 30, 'Selected application was not captured'
    assert isolation > 25, f'Other application leaked into capture: {isolation:.1f} dB'
    result = {'capture': 'passed', 'isolationDb': round(isolation, 1), 'targetHz': 440, 'otherHz': 880, 'seconds': 2}
    PLAYERS[0].terminate(); CAPTURE.communicate(timeout=5)
    assert CAPTURE.returncode == 0, 'Capture did not stop cleanly after target exit'
    result['targetExit'] = 'passed'
    (OUT / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
finally:
    if CAPTURE and CAPTURE.poll() is None:
        CAPTURE.kill(); CAPTURE.wait()
    for player in PLAYERS:
        if player.poll() is None:
            player.kill(); player.wait()
