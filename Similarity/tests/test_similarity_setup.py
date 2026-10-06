import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("worker", Path(__file__).resolve().parents[2] / "Similarity" / "worker.py")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class SetupRecoveryTests(unittest.TestCase):
    def test_initialization_failure_invalidates_previous_readiness(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            marker = cache / (worker.METHOD + ".ready")
            marker.write_text("previous engine")
            with mock.patch.object(sys, "argv", ["worker", str(cache / "job.json"), str(cache)]), \
                    mock.patch.object(worker, "initialize", side_effect=ValueError("Missing weights")), \
                    mock.patch.object(worker, "analyze_with_fallback") as analyze:
                with self.assertRaisesRegex(ValueError, "Missing weights"):
                    worker.main()
                analyze.assert_not_called()
            self.assertFalse(marker.exists())

    def test_scoring_failure_does_not_trigger_dependency_reinstall(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            marker = cache / (worker.METHOD + ".ready")
            marker.write_text("healthy engine")
            manifest = cache / "job.json"
            manifest.write_text(json.dumps({"cells": []}))
            with mock.patch.object(sys, "argv", ["worker", str(manifest), str(cache)]), \
                    mock.patch.object(worker, "initialize", return_value=(object(), "engine")) as initialize, \
                    mock.patch.object(worker, "analyze_with_fallback", side_effect=ValueError("Invalid image")):
                with self.assertRaisesRegex(ValueError, "Invalid image"):
                    worker.main()
                initialize.assert_called_once_with(cache, False)
            self.assertEqual(marker.read_text(), "healthy engine")


if __name__ == "__main__":
    unittest.main()
