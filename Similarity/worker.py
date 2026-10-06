import argparse
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
from collections import OrderedDict
from datetime import datetime, timezone

# Retain the original cache/setup identity: LPIPS weights, preprocessing, and arithmetic are unchanged.
METHOD = "lpips-alex-v0.1-rgb512-ssim11-v1"


def progress(message):
    print(f"RG_PROGRESS {message}", flush=True)


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def configure_device(model):
    import torch
    if torch.cuda.is_available():
        # Keep full FP32 precision for near-identical comparisons and compatibility with existing CPU scores.
        if hasattr(torch.backends.cuda.matmul, "fp32_precision"):
            torch.backends.cuda.matmul.fp32_precision = "ieee"
            torch.backends.cudnn.fp32_precision = "ieee"
        else:
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
        try:
            model.to("cuda")
            with torch.inference_mode():
                sample = torch.zeros((1, 3, 64, 64), device="cuda")
                model(sample, sample)
            del sample
            torch.cuda.synchronize()
            progress(f"LPIPS using GPU ({torch.cuda.get_device_name()}).")
            return model
        except RuntimeError as error:
            print(f"GPU similarity initialization failed: {error}", file=sys.stderr)
        # Leave the exception scope before cleanup so failed CUDA tensors can be reclaimed.
        sample = None
        model.cpu()
        gc.collect()
        torch.cuda.empty_cache()
        progress("GPU unavailable or out of memory; using CPU for similarity.")
        return model
    else:
        progress("No CUDA GPU available; using CPU for similarity.")
    return model.cpu()


def initialize(cache, setup):
    packages = cache / "packages"
    sys.path.insert(0, str(packages))
    os.environ["TORCH_HOME"] = str(cache / "torch")
    if setup:
        progress("Setting up similarity dependencies…")
        subprocess.run([sys.executable, "-s", "-m", "pip", "install", "--disable-pip-version-check",
                        "--no-deps", "--target", str(packages), "lpips==0.1.4"],
                       check=True, stdout=sys.stderr, stderr=sys.stderr)
    try:
        import torch
        import torchvision
        import numpy
        import PIL
        import lpips
    except (ImportError, RuntimeError) as error:
        raise ValueError("Similarity needs compatible torch, torchvision, numpy, Pillow, scipy and tqdm in the server's Python runtime. "
                         "Use a local ComfyUI runtime or set RUNNING_GRID_PYTHON, then click Analyze similarity to retry setup.") from error
    weights = cache / "torch" / "hub" / "checkpoints" / "alexnet-owt-7be5be79.pth"
    if not setup and not weights.exists():
        raise ValueError("Similarity weights are missing. Click Analyze similarity to set them up again.")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    progress("Loading similarity weights…")
    model = configure_device(lpips.LPIPS(net="alex", version="0.1", verbose=False).eval())
    # SciPy is still an upstream LPIPS dependency. Device is excluded: both use FP32.
    versions = {name: importlib.metadata.version(name) for name in
                ("torch", "torchvision", "numpy", "Pillow", "scipy", "lpips")}
    versions["trunk"] = digest(weights)
    versions["linear"] = digest(Path(lpips.__file__).parent / "weights" / "v0.1" / "alex.pth")
    engine = hashlib.sha256(json.dumps(versions, sort_keys=True).encode()).hexdigest()
    (cache / (METHOD + ".ready")).write_text(engine, encoding="ascii")
    return model, engine


def load_pixels(path):
    import numpy as np
    from PIL import Image, ImageOps
    with Image.open(path) as source:
        if getattr(source, "n_frames", 1) != 1:
            raise ValueError("Animated images are not scored")
        source = ImageOps.exif_transpose(source)
        size = source.size
        if min(size) < 64:
            raise ValueError("Images smaller than 64 pixels are not scored")
        rgba = source.convert("RGBA")
        image = Image.new("RGBA", rgba.size, "white")
        image.alpha_composite(rgba)
        image = image.convert("RGB")
        image.thumbnail((512, 512), Image.Resampling.LANCZOS)
        if min(image.size) < 64:
            raise ValueError("Image aspect ratio is too narrow for the scoring resolution")
        return size, np.asarray(image, dtype=np.float64) / 255.0


def features(model, pixels):
    """Compute reusable LPIPS features, matching upstream LPIPS.forward exactly."""
    import lpips
    import torch
    image = torch.from_numpy(pixels.copy()).permute(2, 0, 1).unsqueeze(0).float() * 2 - 1
    image = image.to(next(model.parameters()).device)
    with torch.inference_mode():
        return [lpips.normalize_tensor(layer) for layer in model.net(model.scaling_layer(image))]


def distance(model, a, b):
    import torch
    with torch.inference_mode():
        # Accumulate in double precision, as Python's original CPU sum did, with only one GPU synchronization.
        values = [model.lins[index]((left - right)**2).mean().double()
                  for index, (left, right) in enumerate(zip(a, b))]
        return max(0.0, float(sum(values)))


def analyze(job, cache_path, model, engine):
    if job["method"] != METHOD:
        raise ValueError("Scoring worker and extension versions do not match. Restart SwarmUI.")
    try:
        old_cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    except (json.JSONDecodeError, OSError):
        old_cache = {}
    cached = old_cache.get("scores", {}) if old_cache.get("engine") == engine and old_cache.get("method") == METHOD else {}
    # Drop retired measurements while keeping the exact cached LPIPS values, including row checkpoints.
    cached = {key: {"lpips": score["lpips"]} for key, score in cached.items()}
    retained = {}
    pairs = {}
    issues = []
    cells = {(cell["column"], cell["row"]): cell for cell in job["cells"]}
    columns = sorted(column["key"] for column in job["columns"])
    computed = 0
    reused = 0
    for row_index, row in enumerate(job["rows"]):
        device = "GPU" if next(model.parameters()).device.type == "cuda" else "CPU"
        progress(f"Analyzing row {row_index + 1} / {len(job['rows'])} — LPIPS {device}…")
        loaded = {}
        prepared = OrderedDict()

        def prepare(image):
            key = image["hash"]
            if key not in prepared:
                if len(prepared) >= 12:
                    prepared.popitem(last=False)
                pixels = image["pixels"].astype("float64") / 255.0
                prepared[key] = features(model, pixels)
            prepared.move_to_end(key)
            return prepared[key]
        for column in columns:
            cell = cells.get((column, row))
            if cell is None:
                continue
            try:
                # Hash the exact bytes decoded, avoiding a hash/read race if an external editor changes a file.
                import io
                raw = Path(cell["path"]).read_bytes()
                size, pixels = load_pixels(io.BytesIO(raw))
                loaded[column] = {"hash": hashlib.sha256(raw).hexdigest(), "size": size,
                                  "pixels": (pixels * 255).round().astype("uint8"),
                                  "settings": cell.get("settings"), "version": cell.get("version", "")}
            except (OSError, ValueError) as error:
                issues.append({"stem": cell["stem"], "reason": str(error) if isinstance(error, ValueError) else "Image missing or unreadable"})
        for index, a in enumerate(columns):
            for b in columns[index + 1:]:
                left, right = loaded.get(a), loaded.get(b)
                if left is None or right is None or left["size"] != right["size"]:
                    continue
                key = ":".join(sorted([left["hash"], right["hash"]]))
                scores = cached.get(key)
                if scores is None:
                    if left["hash"] == right["hash"]:
                        scores = {"lpips": 0.0}
                    else:
                        prepared_left, prepared_right = prepare(left), prepare(right)
                        scores = {"lpips": distance(model, prepared_left, prepared_right)}
                    cached[key] = scores
                    computed += 1
                else:
                    reused += 1
                retained[key] = scores
                settings = "unknown" if not left["settings"] or not right["settings"] else (
                    "same" if left["settings"] == right["settings"] else "different")
                pair = pairs.setdefault((a, b), {"a": a, "b": b, "rows": []})
                pair["rows"].append({"key": row, **scores, "settings": settings,
                                     "a_version": left["version"], "b_version": right["version"]})
        atomic_json(cache_path, {"method": METHOD, "engine": engine, "scores": cached})
    atomic_json(cache_path, {"method": METHOD, "engine": engine, "scores": retained})
    return {"method": METHOD, "engine": engine, "updated": datetime.now(timezone.utc).isoformat(),
            "columns": job["columns"], "expected_rows": len(job["rows"]),
            "pairs": list(pairs.values()), "issues": issues, "computed": computed, "reused": reused}


def analyze_with_fallback(job, cache_path, model, engine):
    import torch
    try:
        return analyze(job, cache_path, model, engine)
    except torch.cuda.OutOfMemoryError:
        if next(model.parameters()).device.type != "cuda":
            raise
    # The failed analysis stack (and its GPU feature cache) must be released before the retry.
    model.cpu()
    gc.collect()
    torch.cuda.empty_cache()
    progress("GPU ran out of memory; continuing similarity on CPU with cached comparisons.")
    return analyze(job, cache_path, model, engine)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--setup", action="store_true")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    try:
        model, engine = initialize(args.cache, args.setup)
    except Exception:
        # The same Analyze action will offer setup on retry, under the existing install permission.
        (args.cache / (METHOD + ".ready")).unlink(missing_ok=True)
        raise
    job = json.loads(args.manifest.read_text(encoding="utf-8"))
    result = analyze_with_fallback(job, args.manifest.parent / "cache.json", model, engine)
    atomic_json(args.manifest.parent / "result.json", result)
    progress(f"Similarity updated: {result['computed']} new comparisons, {result['reused']} reused.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"RG_ERROR {error}" if isinstance(error, ValueError)
              else "RG_ERROR Similarity failed. See server log for details, then click Analyze similarity to retry.", file=sys.stderr)
        sys.exit(1)
