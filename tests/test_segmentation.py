import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from segmentation import Segmenter, PendingUtterances, Utterance, trim_overlap, FRAME, RATE

class SegmentationTests(unittest.TestCase):
    def test_silence_never_emits_utterance(self):
        s = Segmenter()
        for i in range(500):
            self.assertIsNone(s.push(np.zeros(FRAME, dtype=np.float32), 0.01, i * FRAME / RATE))

    def test_waits_half_second_after_voice(self):
        s = Segmenter()
        frame = np.ones(FRAME, dtype=np.float32)
        for i in range(20):
            self.assertIsNone(s.push(frame, .9, i * FRAME / RATE))
        for i in range(15):
            self.assertIsNone(s.push(frame * 0, .01, (20 + i) * FRAME / RATE))
        result = s.push(frame * 0, .01, 35 * FRAME / RATE)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result.ended_at, 19 * FRAME / RATE)

    def test_continuous_speech_is_bounded_and_carries_overlap(self):
        s = Segmenter()
        results = []
        for i in range(300):
            item = s.push(np.ones(FRAME, dtype=np.float32), .9, i * FRAME / RATE)
            if item:
                results.append(item)
        self.assertEqual(len(results), 2)
        self.assertLessEqual(len(results[0].audio), RATE * 4 + FRAME)
        self.assertGreater(results[1].overlap, 0)

    def test_short_noise_is_discarded(self):
        s = Segmenter()
        self.assertIsNone(s.push(np.zeros(FRAME, dtype=np.float32), .9, 0))
        for i in range(17):
            self.assertIsNone(s.push(np.zeros(FRAME, dtype=np.float32), 0, i * FRAME / RATE))

    def test_overlap_expires_after_silence_before_unrelated_sentence(self):
        s = Segmenter()
        for i in range(125):
            s.push(np.ones(FRAME, dtype=np.float32), .9, i * FRAME / RATE)
        self.assertGreater(s.overlap, 0)
        for i in range(8):
            s.push(np.zeros(FRAME, dtype=np.float32), .01, 4 + i * FRAME / RATE)
        self.assertEqual(s.overlap, 0)

    def test_overlap_dedup_keeps_legitimate_repeated_sentences(self):
        self.assertEqual(trim_overlap('ありがとう。', 'ありがとう。', False), 'ありがとう。')
        self.assertEqual(trim_overlap('今日はいい天気', 'いい天気ですね。', True), 'ですね。')

    def test_preview_arrives_before_speech_ends_and_final_uses_same_id(self):
        s = Segmenter(streaming=True, interval_ms=640)
        previews, final = [], None
        for i in range(70):
            result = s.push(np.ones(FRAME, dtype=np.float32), .9, (i + 1) * FRAME / RATE)
            if result:
                previews.append(result)
        self.assertGreaterEqual(len(previews), 3)
        self.assertFalse(previews[0].is_final)
        self.assertLessEqual(len(previews[0].audio) / RATE, .672)
        for i in range(10):
            result = s.push(np.zeros(FRAME, dtype=np.float32), .01, (71 + i) * FRAME / RATE)
            if result:
                final = result
        self.assertTrue(final.is_final)
        self.assertEqual(final.utterance_id, previews[0].utterance_id)
        self.assertGreater(final.revision, previews[-1].revision)

    def test_pending_snapshots_coalesce_and_preserve_final_jobs(self):
        q = PendingUtterances()
        def job(id, revision, final=False):
            return Utterance(np.zeros(FRAME), 1, 0, id, revision, final)
        for revision in range(1, 20):
            self.assertFalse(q.put(job(1, revision)))
        self.assertEqual(len(q.items), 1)
        q.put(job(1, 20, True)); q.put(job(2, 1)); q.put(job(3, 1))
        self.assertEqual(q.get().revision, 20)
        self.assertEqual(q.get().utterance_id, 3)

    def test_overload_is_bounded_even_with_many_finalized_utterances(self):
        q = PendingUtterances()
        drops = sum(q.put(Utterance(np.zeros(FRAME), 1, 0, i, 1, True)) for i in range(8))
        self.assertEqual(drops, 5)
        self.assertEqual([q.get().utterance_id for _ in range(3)], [5, 6, 7])

if __name__ == '__main__':
    unittest.main()
