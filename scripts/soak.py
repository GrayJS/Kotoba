"""Real offline ASR + local Ollama endurance/latency check; never plays audio."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import sys
import time
from urllib.request import Request, urlopen
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
os.environ['KOTOBA_GPU_PATH'] = str(ROOT / 'build/gpu')
import worker  # installs CUDA DLL search directories before importing CTranslate2
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=1800)
args = parser.parse_args()
config = json.loads((ROOT / 'config.json').read_text(encoding='utf-8-sig'))
model_dir = (ROOT / config['asr']['modelPath']).resolve()
model = WhisperModel(str(model_dir), device='cuda', compute_type='int8_float16', cpu_threads=6, local_files_only=True)
clips = [decode_audio(str(ROOT / 'build/speech-test' / f'BASIC5000_{i:04d}.wav')) for i in (1, 2, 3)]
class Counters(ctypes.Structure):
    _fields_ = [('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong),('PeakWorkingSetSize',ctypes.c_size_t),('WorkingSetSize',ctypes.c_size_t),('QuotaPeakPagedPoolUsage',ctypes.c_size_t),('QuotaPagedPoolUsage',ctypes.c_size_t),('QuotaPeakNonPagedPoolUsage',ctypes.c_size_t),('QuotaNonPagedPoolUsage',ctypes.c_size_t),('PagefileUsage',ctypes.c_size_t),('PeakPagefileUsage',ctypes.c_size_t)]
def rss():
    c = Counters(); c.cb = ctypes.sizeof(c)
    ctypes.windll.kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb):
        raise ctypes.WinError()
    return round(c.WorkingSetSize / 1024**2, 1)
def translate(text, context):
    messages = [{'role':'system','content':'将当前日语句子翻译成简体中文，只输出译文，不要解释。'}]
    for item in context:
        messages.extend([{'role':'user','content':item[0]}, {'role':'assistant','content':item[1]}])
    messages.append({'role':'user','content':text})
    payload = {'model':config['ollama']['model'],'messages':messages,'stream':False,'think':False,'keep_alive':'5m','options':{'num_ctx':4096,'num_predict':256,'temperature':0.1}}
    req = Request(config['ollama']['baseUrl']+'/api/chat', data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'})
    with urlopen(req, timeout=120) as response:
        return json.load(response)['message']['content']
start = time.monotonic()
results, context, errors = [], [], []
out = ROOT / 'artifacts/soak-result.json'; out.parent.mkdir(exist_ok=True)
while time.monotonic() - start < args.seconds:
    n = len(results)
    begun = time.perf_counter()
    try:
        segments, _ = model.transcribe(clips[n % len(clips)], language='ja', beam_size=1, condition_on_previous_text=False, vad_filter=True)
        japanese = ''.join(segment.text for segment in segments).strip()
        if not japanese: raise RuntimeError('No speech recognized from public Japanese sample')
        chinese = translate(japanese, context)
        if not chinese: raise RuntimeError('Empty translation')
        context = (context + [(japanese, chinese)])[-2:]
        elapsed = (time.perf_counter() - begun) * 1000
        results.append({'iteration':n+1,'processingMs':round(elapsed),'rssMB':rss()})
    except Exception as error:
        errors.append({'iteration':n+1,'error':str(error)})
    snapshot = {'durationSeconds':round(time.monotonic()-start),'targetSeconds':args.seconds,'iterations':len(results),'errors':errors,
                'p50ProcessingMs':round(float(np.percentile([r['processingMs'] for r in results[1:]] or [0],50))),
                'p95ProcessingMs':round(float(np.percentile([r['processingMs'] for r in results[1:]] or [0],95))), 'samples':results}
    out.write_text(json.dumps(snapshot, indent=2))
    if n % 12 == 0: print(json.dumps({k:v for k,v in snapshot.items() if k not in ('samples','errors')}), flush=True)
    time.sleep(max(0, 5 - (time.perf_counter()-begun)))
snapshot['durationSeconds'] = round(time.monotonic()-start)
snapshot['completed'] = True
out.write_text(json.dumps(snapshot, indent=2))
print(json.dumps({'completed':True,'iterations':len(results),'errors':len(errors),'seconds':snapshot['durationSeconds']}), flush=True)
sys.exit(1 if errors else 0)
