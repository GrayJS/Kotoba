"""NDJSON control/status over stdio; never write captured audio or transcripts to disk."""
import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

# Keep DLL directory handles alive for the lifetime of the process.
DLL_HANDLES = []
if os.name == 'nt':
    for directory in os.environ.get('KOTOBA_GPU_PATH', '').split(os.pathsep):
        if directory and os.path.isdir(directory):
            DLL_HANDLES.append(os.add_dll_directory(directory))
            os.environ['PATH'] = directory + os.pathsep + os.environ.get('PATH', '')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('DO_NOT_TRACK', '1')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')

import numpy as np
import soxr
from segmentation import FRAME, RATE, Segmenter, PendingUtterances, trim_overlap

MODEL_ID = 'dropbox-dash/faster-whisper-large-v3-turbo'
MODEL_REVISION = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
FILES = ['config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json']
OUT_LOCK = threading.Lock()


def watch_host(pid):
    """Do not leave a GPU worker or its capture child behind if Electron crashes."""
    if os.name != 'nt' or not pid:
        return
    import ctypes
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        os._exit(0)
    try:
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
    finally:
        kernel.CloseHandle(handle)
    os._exit(0)


def emit(kind, **values):
    with OUT_LOCK:
        print(json.dumps({'type': kind, **values}, ensure_ascii=False), flush=True)


class StreamingVad:
    def __init__(self):
        from faster_whisper.vad import get_vad_model
        self.session = get_vad_model().session
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(64, dtype=np.float32)

    def probability(self, frame):
        data = np.concatenate((self.context, frame))[None, :]
        output, self.h, self.c = self.session.run(None, {'input': data, 'h': self.h, 'c': self.c})
        self.context = frame[-64:].copy()
        return float(output.reshape(-1)[0])


class SpeechLanguages:
    """Reuse confident detection within one utterance only; each capture session owns its tracker."""
    def __init__(self, language):
        self.manual = None if language == 'auto' else language
        self.detected = {}

    def request(self, utterance_id):
        return self.manual or self.detected.get(utterance_id)

    def observe(self, utterance_id, info, samples, text):
        if not self.manual and text and samples >= RATE and getattr(info, 'language_probability', 0) >= 0.7:
            self.detected.setdefault(utterance_id, info.language)
        self.detected = {key: value for key, value in self.detected.items() if key >= utterance_id - 6}
        return self.request(utterance_id)


class CaptureSession:
    def __init__(self, worker, session_id, pid, capture, streaming=True, language='ja'):
        self.worker, self.session_id = worker, session_id
        self.stopped = threading.Event()
        self.queue = PendingUtterances(capacity=3)
        self.streaming = streaming
        self.languages = SpeechLanguages(language)
        self.process = subprocess.Popen(
            [capture, '--pid', str(pid), '--parent', str(os.getpid())],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        threading.Thread(target=self.read_errors, daemon=True).start()
        threading.Thread(target=self.capture_audio, daemon=True).start()
        threading.Thread(target=self.recognize, daemon=True).start()

    def event(self, kind, **values):
        if not self.stopped.is_set():
            emit(kind, session=self.session_id, **values)

    def read_errors(self):
        for line in self.process.stderr:
            try:
                message = json.loads(line)
                kind = message.pop('type')
                self.event(kind, **message)
            except (ValueError, KeyError):
                self.event('capture_error', message='Invalid response from audio capture component')

    def capture_audio(self):
        try:
            vad = StreamingVad()
            segmenter = Segmenter(streaming=self.streaming, interval_ms=640 if self.worker.device == 'cuda' else 1200)
            resampler = soxr.ResampleStream(48000, RATE, 1, dtype='float32', quality='HQ')
            pending = np.array([], dtype=np.float32)
            last_level = 0
            while not self.stopped.is_set():
                raw = self.process.stdout.read(3840)  # 20 ms, stereo PCM16
                if not raw:
                    break
                if len(raw) % 4:
                    raise RuntimeError('Truncated PCM audio frame')
                stereo = np.frombuffer(raw, dtype='<i2').reshape(-1, 2).astype(np.float32) / 32768.0
                mono = stereo.mean(axis=1)
                pending = np.concatenate((pending, resampler.resample_chunk(mono)))
                now = time.time()
                if now - last_level >= 0.12:
                    self.event('level', value=min(1.0, float(np.sqrt(np.mean(mono * mono))) * 5))
                    last_level = now
                while len(pending) >= FRAME:
                    frame, pending = pending[:FRAME], pending[FRAME:]
                    utterance = segmenter.push(frame, vad.probability(frame), now - len(pending) / RATE)
                    if utterance is not None:
                        utterance.queued_at = time.monotonic()
                        if self.queue.put(utterance):
                            self.event('dropped', stage='recognition')
            if not self.stopped.is_set():
                # Let stderr reader deliver the more specific target-exit/error first.
                self.process.wait(timeout=3)
                time.sleep(0.05)
                self.event('capture_ended', message='音频采集已结束，请重新选择应用')
        except Exception as error:
            self.event('capture_error', message=str(error))
        finally:
            if not self.stopped.is_set():
                self.stop()

    def recognize(self):
        previous, previous_id = '', 0
        last_text = {}
        first_text_ms = {}
        while not self.stopped.is_set():
            try:
                utterance = self.queue.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                started = time.perf_counter()
                queue_ms = round((time.monotonic() - utterance.queued_at) * 1000)
                # A single model lock prevents overlapping sessions from using the GPU.
                with self.worker.model_lock:
                    if self.stopped.is_set():
                        break
                    language = self.languages.request(utterance.utterance_id)
                    segments, info = self.worker.model.transcribe(
                        utterance.audio, language=language, task='transcribe', beam_size=1,
                        temperature=0.0, condition_on_previous_text=False, vad_filter=False,
                        word_timestamps=False, no_speech_threshold=0.6,
                    )
                    text = ''.join(s.text for s in segments if s.avg_logprob > -1.0 and s.no_speech_prob < 0.6 and s.compression_ratio < 2.4).strip()
                    source_language = self.languages.observe(utterance.utterance_id, info, len(utterance.audio), text)
                text = trim_overlap(previous, text, utterance.overlap > 0 and previous_id == utterance.utterance_id - 1)
                if not text and utterance.is_final:
                    text = last_text.get(utterance.utterance_id, '')
                if not text:
                    continue
                if text == last_text.get(utterance.utterance_id) and not utterance.is_final:
                    continue
                last_text[utterance.utterance_id] = text
                if utterance.is_final:
                    previous, previous_id = text, utterance.utterance_id
                if utterance.utterance_id not in first_text_ms:
                    first_text_ms[utterance.utterance_id] = round((time.time() - utterance.started_at) * 1000)
                self.event('transcript', id=utterance.utterance_id, revision=utterance.revision, isFinal=utterance.is_final,
                           japanese=text, sourceLanguage=source_language,
                           startedAt=utterance.started_at * 1000, endedAt=utterance.ended_at * 1000,
                           firstTextMs=first_text_ms[utterance.utterance_id], queueMs=queue_ms,
                           recognitionMs=round((time.perf_counter() - started) * 1000))
                for old_id in list(last_text):
                    if old_id < utterance.utterance_id - 6:
                        last_text.pop(old_id, None)
                        first_text_ms.pop(old_id, None)
            except Exception as error:
                self.event('recognition_error', message=str(error))
                self.stop()

    def stop(self):
        self.stopped.set()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
        # Drains are bounded, so no retained audio after stopping.
        self.queue.clear()


class Worker:
    def __init__(self, model_dir, capture):
        self.model_dir = Path(model_dir)
        self.capture = capture
        self.model = None
        self.device = None
        self.session = None
        self.model_lock = threading.Lock()
        self.preparing = False
        self.downloading = False

    def start_download(self):
        if self.downloading or self.preparing or self.session:
            raise RuntimeError('下载、检查与监听不能同时进行')
        self.downloading = True
        def run():
            try:
                self.download()
                self.downloading = False
                emit('download_complete')
            except Exception as error:
                self.downloading = False
                emit('download_error', message=str(error))
        threading.Thread(target=run, daemon=True).start()

    def download(self):
        from huggingface_hub import snapshot_download
        from tqdm.auto import tqdm

        class Progress(tqdm):
            last_report = 0
            def update(self, n=1):
                result = super().update(n)
                if time.monotonic() - self.last_report > 0.3:
                    self.last_report = time.monotonic()
                    emit('progress', stage='asr', label='下载语音识别模型 · ' + str(self.desc or ''),
                         percent=round(self.n / self.total * 100) if self.total else None)
                return result

        self.model_dir.mkdir(parents=True, exist_ok=True)
        marker = self.model_dir / '.complete'
        if marker.exists() and marker.read_text() == MODEL_REVISION and all((self.model_dir / f).is_file() and (self.model_dir / f).stat().st_size > 0 for f in FILES):
            return
        emit('progress', stage='asr', label='连接模型下载源', percent=None)
        snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=str(self.model_dir),
                          allow_patterns=FILES, max_workers=1, tqdm_class=Progress)
        if not all((self.model_dir / f).is_file() and (self.model_dir / f).stat().st_size > 0 for f in FILES):
            raise RuntimeError('语音识别模型文件不完整，请重试下载')
        marker.write_text(MODEL_REVISION)

    def prepare(self, device):
        if self.preparing or self.downloading:
            emit('error', message='模型正在准备，请稍候')
            return
        self.preparing = True
        def run():
            try:
                self.stop()
                if not all((self.model_dir / f).is_file() for f in ('config.json', 'model.bin', 'tokenizer.json')):
                    raise RuntimeError('语音识别模型目录缺少 config.json、model.bin 或 tokenizer.json，请检查 asr.modelPath')
                emit('progress', stage='check', label='正在加载模型并进行真实推理自检', percent=None)
                from faster_whisper import WhisperModel
                with self.model_lock:
                    self.model = None
                    self.device = None
                    model = WhisperModel(str(self.model_dir), device=device,
                                         compute_type='int8_float16' if device == 'cuda' else 'int8',
                                         cpu_threads=6, num_workers=1, local_files_only=True)
                    segments, _ = model.transcribe(np.zeros(RATE, dtype=np.float32), language='ja', beam_size=1, vad_filter=False)
                    list(segments)  # materialize lazy inference; loading alone does not test CUDA DLLs
                    StreamingVad().probability(np.zeros(FRAME, dtype=np.float32))
                    self.model, self.device = model, device
                self.preparing = False
                emit('ready', device=device)
            except Exception as error:
                emit('device_error', device=device, message=str(error))
            finally:
                self.preparing = False
        threading.Thread(target=run, daemon=True).start()

    def start(self, session, pid, device, streaming=True, language='ja'):
        if language not in ('auto', 'ja', 'en', 'zh', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it', 'ar', 'hi'):
            raise ValueError('Unsupported source language')
        if self.preparing or self.downloading or self.model is None or self.device != device:
            raise RuntimeError('当前计算设备尚未通过自检')
        self.stop()
        self.session = CaptureSession(self, session, pid, self.capture, streaming, language)

    def stop(self):
        if self.session:
            self.session.stop()
            self.session = None

    def serve(self):
        emit('worker_ready')
        try:
            for line in sys.stdin:
                try:
                    command = None
                    command = json.loads(line)
                    action = command.get('action')
                    if action == 'download':
                        self.start_download()
                    elif action == 'check':
                        device = command.get('device', 'cuda')
                        if device not in ('cuda', 'cpu'):
                            raise ValueError('Unknown compute device')
                        self.prepare(device)
                    elif action == 'start':
                        self.start(command['session'], int(command['pid']), command['device'], bool(command.get('streaming', True)), command.get('language', 'ja'))
                    elif action == 'stop':
                        self.stop()
                    elif action == 'quit':
                        break
                    else:
                        raise ValueError('Unknown worker command')
                except Exception as error:
                    emit('error', session=command.get('session') if isinstance(command, dict) else None, message=str(error))
        finally:
            self.stop()


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stdin.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--capture', default='')
    parser.add_argument('--host-pid', type=int, default=0)
    parser.add_argument('--download-model', action='store_true', help='Explicitly download the ASR model, then exit')
    args = parser.parse_args()
    if args.host_pid:
        threading.Thread(target=watch_host, args=(args.host_pid,), daemon=True).start()
    instance = Worker(args.model_dir, args.capture)
    if args.download_model:
        instance.download()
        emit('download_complete')
    else:
        instance.serve()
