import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from worker import Worker, SpeechLanguages, FILES, MODEL_REVISION, RATE


class SetupTests(unittest.TestCase):
    def test_language_detection_is_per_utterance_and_per_session(self):
        auto = SpeechLanguages('auto')
        ja = SimpleNamespace(language='ja', language_probability=.98)
        en = SimpleNamespace(language='en', language_probability=.99)
        self.assertIsNone(auto.observe(1, ja, RATE // 2, 'short'))
        self.assertIsNone(auto.observe(1, ja, RATE, ''))
        self.assertIsNone(auto.observe(1, SimpleNamespace(language='ja', language_probability=.4), RATE, 'uncertain'))
        self.assertEqual(auto.observe(1, ja, RATE, 'speech'), 'ja')
        self.assertEqual(auto.request(1), 'ja')
        self.assertEqual(auto.observe(1, en, RATE, 'revision'), 'ja')
        self.assertIsNone(auto.request(2))
        self.assertEqual(auto.observe(2, en, RATE, 'new sentence'), 'en')
        self.assertIsNone(SpeechLanguages('auto').request(1))
        manual = SpeechLanguages('en')
        self.assertEqual(manual.observe(1, ja, RATE, 'text'), 'en')

    def test_download_failure_retry_and_completed_model_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Worker(directory, '')
            calls = []
            def download(*args, **kwargs):
                calls.append(kwargs)
                if len(calls) == 1:
                    raise OSError('connection interrupted')
                for file in FILES:
                    (Path(directory) / file).write_text('test fixture')
            with patch('huggingface_hub.snapshot_download', side_effect=download), patch('worker.emit'):
                with self.assertRaises(OSError): worker.download()
                self.assertFalse((Path(directory) / '.complete').exists())
                worker.download()
                self.assertEqual((Path(directory) / '.complete').read_text(), MODEL_REVISION)
                worker.download()
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[-1]['revision'], MODEL_REVISION)
                self.assertEqual(calls[-1]['allow_patterns'], FILES)

    def test_download_does_not_block_control_and_rejects_conflicting_work(self):
        worker = Worker('.', '')
        events = []
        with patch.object(worker, 'download', side_effect=lambda: time.sleep(.08)), patch('worker.emit', side_effect=lambda kind, **kw: events.append(kind)):
            worker.start_download()
            self.assertTrue(worker.downloading)
            with self.assertRaises(RuntimeError): worker.start_download()
            with self.assertRaises(RuntimeError): worker.start('s', 1, 'cuda')
            worker.prepare('cpu')
            self.assertFalse(worker.preparing)
            for _ in range(100):
                if 'download_complete' in events: break
                time.sleep(.01)
            self.assertIn('download_complete', events)
            self.assertFalse(worker.downloading)


if __name__ == '__main__': unittest.main()
