import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

import numpy as np
from PIL import Image
import torch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("worker", ROOT / "Similarity" / "worker.py")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class SimilarityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model, cls.engine = worker.initialize(ROOT / ".cache" / "test-weights", False)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.pixels = np.random.default_rng(42).integers(0, 256, (96, 96, 3), dtype=np.uint8)

    def tearDown(self):
        self.temporary.cleanup()

    def cell(self, column, row, pixels=None, settings="baseline"):
        path = self.folder / f"{column}-{row}.png"
        Image.fromarray(self.pixels if pixels is None else pixels).save(path)
        return {"column": column, "row": row, "stem": f"{column}/{row}", "path": str(path), "settings": settings}

    def job(self, cells, columns=("a", "b"), rows=("seed1", "seed2")):
        return {"method": worker.METHOD, "columns": [{"key": key, "title": key} for key in columns],
                "rows": list(rows), "cells": cells}

    def analyze(self, job, engine=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return worker.analyze(job, self.folder / "cache.json", self.model, engine or self.engine)

    def test_feature_reuse_is_equal_to_upstream_lpips(self):
        a = self.pixels.astype(np.float64) / 255
        b = np.roll(a, 3, axis=0)
        cached = worker.distance(self.model, worker.features(self.model, a), worker.features(self.model, b))
        tensors = [(torch.from_numpy(value.copy()).permute(2, 0, 1).unsqueeze(0).float() * 2 - 1)
                   .to(next(self.model.parameters()).device) for value in (a, b)]
        with torch.inference_mode():
            expected = float(self.model(*tensors))
        self.assertAlmostEqual(cached, expected, places=7)
        self.assertGreater(cached, 0)

    def test_legacy_cache_keeps_exact_lpips_without_rescoring_or_retired_metrics(self):
        cells = [self.cell("a", "seed1"), self.cell("b", "seed1", np.roll(self.pixels, 4, axis=0))]
        key = ":".join(sorted(worker.digest(cell["path"]) for cell in cells))
        cached_distance = .1234567890123456
        worker.atomic_json(self.folder / "cache.json", {
            "method": "lpips-alex-v0.1-rgb512-ssim11-v1", "engine": self.engine,
            "scores": {key: {"lpips": cached_distance, "ssim": .9876}}
        })
        with mock.patch.object(worker, "features", side_effect=AssertionError("Cached images must not be rescored")), \
                mock.patch.object(worker, "distance", side_effect=AssertionError("Cached pairs must not be rescored")):
            result = self.analyze(self.job(cells, rows=("seed1",)))
        self.assertEqual((result["computed"], result["reused"]), (0, 1))
        score = result["pairs"][0]["rows"][0]
        self.assertEqual(score["lpips"], cached_distance)
        self.assertNotIn("ssim", score)
        cache = json.loads((self.folder / "cache.json").read_text())
        self.assertEqual(cache["scores"], {key: {"lpips": cached_distance}})
        self.assertEqual(self.analyze(self.job(cells, rows=("seed1",)))["reused"], 1)

    def test_only_same_rows_and_dimensions_match(self):
        cells = [self.cell("a", "seed1"), self.cell("b", "seed2"),
                 self.cell("a", "seed2", np.zeros((96, 128, 3), dtype=np.uint8))]
        self.assertEqual(self.analyze(self.job(cells))["pairs"], [])

    def test_cache_reuses_identical_content_and_invalidates_changed_content(self):
        cells = [self.cell("a", "seed1"), self.cell("b", "seed1", np.roll(self.pixels, 4, axis=0))]
        job = self.job(cells, rows=("seed1",))
        first = self.analyze(job)
        self.assertEqual(first["computed"], 1)
        self.assertNotIn("ssim", first["pairs"][0]["rows"][0])
        self.assertEqual(self.analyze(job)["reused"], 1)
        job["columns"].reverse()
        self.assertEqual(self.analyze(job)["reused"], 1)
        stamp = os.stat(cells[1]["path"])
        Image.fromarray(np.roll(self.pixels, 9, axis=0)).save(cells[1]["path"])
        os.utime(cells[1]["path"], ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        changed = self.analyze(job)
        self.assertEqual(changed["computed"], 1)
        self.assertNotEqual(changed["pairs"][0]["rows"][0]["lpips"], first["pairs"][0]["rows"][0]["lpips"])
        self.assertEqual(self.analyze(job, engine="new-worker-version")["computed"], 1)

    def test_appends_only_new_pairs_and_prunes_deleted_pairs(self):
        cells = [self.cell(key, "seed1", np.roll(self.pixels, index * 3, axis=0)) for index, key in enumerate("abc")]
        self.analyze(self.job(cells[:2], rows=("seed1",)))
        updated = self.analyze(self.job(cells, columns=tuple("abc"), rows=("seed1",)))
        self.assertEqual((updated["computed"], updated["reused"]), (2, 1))
        updated = self.analyze(self.job(cells[1:], columns=tuple("bc"), rows=("seed1",)))
        self.assertEqual(len(updated["pairs"]), 1)
        cache = json.loads((self.folder / "cache.json").read_text())
        self.assertEqual(len(cache["scores"]), 1)

    def test_identical_images_are_exact_and_overrides_are_flagged(self):
        cells = [self.cell("a", "seed1"), self.cell("b", "seed1", settings="lora")]
        score = self.analyze(self.job(cells))["pairs"][0]["rows"][0]
        self.assertEqual((score["lpips"], score["settings"]), (0, "different"))
        self.assertNotIn("ssim", score)
        cells[1]["settings"] = None
        self.assertEqual(self.analyze(self.job(cells))["pairs"][0]["rows"][0]["settings"], "unknown")

    def test_missing_and_animated_images_remain_unscored(self):
        cells = [self.cell("a", "seed1"), self.cell("b", "seed1")]
        Path(cells[1]["path"]).unlink()
        result = self.analyze(self.job(cells))
        self.assertEqual(result["pairs"], [])
        self.assertEqual(len(result["issues"]), 1)
        animation = self.folder / "animated.webp"
        Image.fromarray(self.pixels).save(animation, save_all=True,
                                        append_images=[Image.fromarray(np.roll(self.pixels, 5, axis=0))], duration=100)
        with self.assertRaisesRegex(ValueError, "Animated"):
            worker.load_pixels(animation)

    def test_preprocessing_preserves_aspect_ratio_and_original_dimensions(self):
        path = self.folder / "wide.png"
        Image.new("RGB", (1024, 768), "red").save(path)
        size, pixels = worker.load_pixels(path)
        self.assertEqual(size, (1024, 768))
        self.assertEqual(pixels.shape, (384, 512, 3))

    def test_prefers_gpu_and_checks_a_real_forward_pass(self):
        model = mock.Mock()
        sample = torch.zeros(1, 3, 64, 64)
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
                mock.patch.object(torch, "zeros", return_value=sample), \
                mock.patch.object(torch.cuda, "synchronize"), \
                mock.patch.object(torch.cuda, "get_device_name", return_value="Test GPU"), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertIs(worker.configure_device(model), model)
        model.to.assert_called_once_with("cuda")
        model.assert_called_once_with(sample, sample)
        model.cpu.assert_not_called()
        self.assertIn("LPIPS using GPU (Test GPU)", output.getvalue())

    def test_cpu_fallback_when_no_gpu_is_available(self):
        model = mock.Mock()
        model.cpu.return_value = model
        with mock.patch.object(torch.cuda, "is_available", return_value=False), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertIs(worker.configure_device(model), model)
        model.to.assert_not_called()
        self.assertIn("No CUDA GPU available", output.getvalue())

    def test_cpu_fallback_when_gpu_initialization_fails(self):
        model = mock.Mock()
        model.cpu.return_value = model
        model.to.side_effect = RuntimeError("GPU cannot initialize")
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
                mock.patch.object(torch.cuda, "empty_cache"), \
                contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            self.assertIs(worker.configure_device(model), model)
        self.assertIn("using CPU", output.getvalue())

    def test_out_of_memory_fallback_reuses_completed_scores(self):
        cells = [self.cell("a", "seed1"), self.cell("b", "seed1", np.roll(self.pixels, 4, axis=0))]
        job = self.job(cells, rows=("seed1",))
        self.analyze(job)
        cpu_model = copy.deepcopy(self.model).cpu()

        class ExhaustedGpu:
            def __init__(self):
                self.on_gpu = True

            def parameters(self):
                return iter([SimpleNamespace(device=torch.device("cuda"))]) if self.on_gpu else cpu_model.parameters()

            def cpu(self):
                self.on_gpu = False
                return self

            def __getattr__(self, name):
                return getattr(cpu_model, name)

        model = ExhaustedGpu()
        original_analyze = worker.analyze

        def limited_memory(*args):
            if model.on_gpu:
                raise torch.cuda.OutOfMemoryError("Simulated GPU memory exhaustion")
            return original_analyze(*args)

        with mock.patch.object(worker, "analyze", side_effect=limited_memory), \
                mock.patch.object(torch.cuda, "empty_cache"), contextlib.redirect_stdout(io.StringIO()):
            result = worker.analyze_with_fallback(job, self.folder / "cache.json", model, self.engine)
        self.assertFalse(model.on_gpu)
        self.assertEqual((result["computed"], result["reused"]), (0, 1))
        self.assertEqual(len(result["pairs"]), 1)

    def test_unrelated_scoring_errors_are_not_retried(self):
        with mock.patch.object(worker, "analyze", side_effect=RuntimeError("Invalid scoring input")) as analyze:
            with self.assertRaisesRegex(RuntimeError, "Invalid scoring input"):
                worker.analyze_with_fallback({}, self.folder / "cache.json", self.model, self.engine)
            self.assertEqual(analyze.call_count, 1)

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA device unavailable")
    def test_gpu_features_and_scores_match_cpu_with_full_precision(self):
        cpu_model = copy.deepcopy(self.model).cpu()
        gpu_model = worker.configure_device(copy.deepcopy(cpu_model))
        self.assertEqual(next(gpu_model.parameters()).device.type, "cuda")
        a = self.pixels.astype(np.float64) / 255
        b = np.clip(a + .005, 0, 1)
        cpu_score = worker.distance(cpu_model, worker.features(cpu_model, a), worker.features(cpu_model, b))
        features_a, features_b = worker.features(gpu_model, a), worker.features(gpu_model, b)
        self.assertTrue(all(value.device.type == "cuda" for value in features_a + features_b))
        gpu_score = worker.distance(gpu_model, features_a, features_b)
        self.assertAlmostEqual(cpu_score, gpu_score, delta=0.000002)
        tensors = [(torch.from_numpy(value.copy()).permute(2, 0, 1).unsqueeze(0).float() * 2 - 1).cuda() for value in (a, b)]
        with torch.inference_mode():
            self.assertAlmostEqual(gpu_score, float(gpu_model(*tensors)), delta=0.000002)


if __name__ == "__main__":
    unittest.main()
