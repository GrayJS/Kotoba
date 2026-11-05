"""Streaming, bounded speech segmentation independent of inference and capture."""
from collections import deque
from dataclasses import dataclass
import queue
import threading
import time
import numpy as np

RATE = 16000
FRAME = 512


@dataclass
class Utterance:
    audio: np.ndarray
    ended_at: float
    overlap: float
    utterance_id: int = 0
    revision: int = 0
    is_final: bool = True
    started_at: float = 0.0
    queued_at: float = 0.0


class Segmenter:
    def __init__(self, streaming=False, interval_ms=640):
        self.pre = deque(maxlen=6)  # 192 ms of context before speech
        self.frames = []
        self.silence = 0
        self.voiced = 0
        self.last_voice = 0.0
        self.overlap = 0.0
        self.streaming = streaming
        self.interval = max(FRAME, int(interval_ms * RATE / 1000))
        self.silence_limit = RATE * (0.32 if streaming else 0.5)
        self.utterance_id = 0
        self.revision = 0
        self.new_samples = 0
        self.last_preview = 0
        self.started_at = 0.0

    def push(self, frame, probability, now):
        speech = probability >= (0.35 if self.frames else 0.5)
        if not self.frames:
            if not speech:
                self.pre.append(frame.copy())
                self.overlap = max(0.0, self.overlap - FRAME / RATE)
                return None
            self.frames = list(self.pre)
            self.pre.clear()
            self.utterance_id += 1
            self.revision = 0
            self.new_samples = self.last_preview = 0
            self.started_at = now - FRAME / RATE
        self.frames.append(frame.copy())
        self.new_samples += FRAME
        if speech:
            self.voiced += FRAME
            self.silence = 0
            self.last_voice = now
        else:
            self.silence += FRAME
        force = len(self.frames) * FRAME >= RATE * 4
        final = self.silence >= self.silence_limit or force
        if not final:
            if not self.streaming or not speech or self.voiced < RATE * 0.16 or self.new_samples - self.last_preview < self.interval:
                return None
            self.last_preview = self.new_samples
            self.revision += 1
            return Utterance(np.concatenate(self.frames), self.last_voice, self.overlap,
                             self.utterance_id, self.revision, False, self.started_at)
        audio = np.concatenate(self.frames)
        self.revision += 1
        result = Utterance(audio, self.last_voice, self.overlap, self.utterance_id,
                           self.revision, True, self.started_at) if self.voiced >= RATE * 0.16 else None
        tail = self.frames[-6:] if force and self.silence < self.silence_limit else []
        self.frames = []
        self.pre = deque(tail, maxlen=6)
        self.overlap = len(tail) * FRAME / RATE
        self.silence = self.voiced = 0
        return result


class PendingUtterances:
    """Keep the newest snapshot per utterance; final jobs survive coalescing."""
    def __init__(self, capacity=3):
        self.items = deque()
        self.capacity = capacity
        self.condition = threading.Condition()

    def put(self, item):
        with self.condition:
            item.queued_at = time.monotonic()
            for index, old in enumerate(self.items):
                if old.utterance_id == item.utterance_id:
                    if item.revision > old.revision:
                        self.items[index] = item
                    self.condition.notify()
                    return False
            self.items = deque(old for old in self.items if old.is_final or old.utterance_id >= item.utterance_id)
            dropped = len(self.items) >= self.capacity
            if dropped:
                self.items.popleft()
            item.queued_at = time.monotonic()
            self.items.append(item)
            self.condition.notify()
            return dropped

    def get(self, timeout=0.2):
        with self.condition:
            if not self.condition.wait_for(lambda: bool(self.items), timeout=timeout):
                raise queue.Empty
            return self.items.popleft()

    def clear(self):
        with self.condition:
            self.items.clear()


def trim_overlap(previous: str, current: str, has_overlap: bool) -> str:
    """Only remove overlap at forced boundaries; repeated complete sentences are valid."""
    current = current.strip()
    if not has_overlap:
        return current
    for length in range(min(len(previous), len(current), 32), 1, -1):
        if previous.endswith(current[:length]):
            return current[length:].lstrip('、。 ，,')
    return current
