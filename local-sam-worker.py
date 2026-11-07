"""App-owned NDJSON SAM 2.1 worker. Images arrive in memory; no network or file image input."""
import base64
import contextlib
import hashlib
import io
import json
import os
import sys
import time

# Restrict optional libraries to local resources even if their APIs change later.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["OMP_NUM_THREADS"] = "4"
os.environ["MKL_NUM_THREADS"] = "4"
runtime_root = os.path.abspath(sys.argv[1])
sys.path.insert(0, os.path.join(runtime_root, "source"))
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    from sam2.utils.amg import rle_to_mask

Image.MAX_IMAGE_PIXELS = 2_560_000
torch.set_num_threads(4)
MODEL = "Meta SAM 2.1 Base Plus"
generator = None
cached_key = None
cached_result = None


def load_model():
    global generator
    if generator is None:
        if not torch.cuda.is_available():
            raise RuntimeError("The local NVIDIA GPU is unavailable. Check the NVIDIA driver and restart Asun IMG.")
        with contextlib.redirect_stdout(sys.stderr):
            model = build_sam2(
                "configs/sam2.1/sam2.1_hiera_b+.yaml",
                os.path.join(runtime_root, "checkpoints", "sam2.1_hiera_base_plus.pt"),
                device="cuda", apply_postprocessing=False,
            )
            generator = SAM2AutomaticMaskGenerator(
                model, points_per_side=32, points_per_batch=32,
                pred_iou_thresh=0.8, stability_score_thresh=0.90,
                crop_n_layers=0, min_mask_region_area=0,
                output_mode="uncompressed_rle", use_m2m=False,
            )
    return generator


def row_rle(mask):
    flat = mask.reshape(-1)
    changes = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    counts = np.diff(np.concatenate(([0], changes, [len(flat)]))).tolist()
    if bool(flat[0]):
        counts.insert(0, 0)
    return counts


def guided_box(message, width, height):
    if "prompt" not in message:
        return None
    prompt = message["prompt"]
    if not isinstance(prompt, dict) or set(prompt) != {"box"}:
        raise ValueError("Guided detection requires one bounding box.")
    box = prompt["box"]
    if not isinstance(box, list) or len(box) != 4 or any(
        isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not np.isfinite(coordinate)
        for coordinate in box
    ) or box[0] < 0 or box[1] < 0 or box[2] > width or box[3] > height or box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("The detection box must lie inside the working image and have a positive size.")
    return np.asarray(box, dtype=np.float32)


def detect(message):
    global cached_key, cached_result
    started = time.perf_counter()
    width, height = message["width"], message["height"]
    if type(width) is not int or type(height) is not int or not 1 <= width <= 1600 or not 1 <= height <= 1600:
        raise ValueError("Detection image must be at most 1600 pixels per side.")
    box = guided_box(message, width, height)
    source = message["source"]
    if not isinstance(source, str) or not source.startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")):
        raise ValueError("Detection accepts an embedded PNG, JPEG or WebP image only.")
    encoded = source.split(",", 1)[1]
    data = base64.b64decode(encoded, validate=True)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError("Detection working image is too large.")
    key = f"{width}x{height}:{hashlib.sha256(data).hexdigest()}"
    if box is None and key == cached_key:
        return dict(cached_result, elapsedMs=round((time.perf_counter() - started) * 1000), cached=True)
    with Image.open(io.BytesIO(data)) as original:
        if original.size != (width, height) or original.format not in ("PNG", "JPEG", "WEBP"):
            raise ValueError("Detection image dimensions or format do not match its uploaded data.")
        image = np.array(original.convert("RGB"), copy=True)
    model = load_model()
    torch.cuda.synchronize()
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16), contextlib.redirect_stdout(sys.stderr):
        if box is None:
            masks = model.generate(image)
        else:
            # The frontend supplies a clean source-image crop. Pencil and
            # highlight overlays only define the box; their color never enters
            # the model. Reuse the automatic generator's already loaded model.
            predictor = model.predictor
            try:
                predictor.set_image(image)
                predictions, scores, _ = predictor.predict(box=box, multimask_output=True)
                order = sorted(range(len(predictions)), key=lambda index: float(scores[index]), reverse=True)
                masks = [{"guided_mask": predictions[index].astype(bool, copy=False),
                          "predicted_iou": float(scores[index]), "stability_score": 1.0,
                          "area": int(predictions[index].sum())} for index in order]
            finally:
                predictor.reset_predictor()
    torch.cuda.synchronize()
    # Keep useful objects and their parts; sorting by confidence avoids noisy masks
    # consuming the bounded response. The UI can select larger overlapping objects.
    masks.sort(key=lambda mask: (mask["predicted_iou"], mask["stability_score"]), reverse=True)
    regions = []
    runs = 0
    minimum = 1 if box is not None else max(24, round(width * height * 0.0001))
    for candidate in masks:
        area = int(candidate["area"])
        if area < minimum or (box is None and area >= width * height * 0.98):
            continue
        mask = candidate["guided_mask"] if box is not None else rle_to_mask(candidate["segmentation"])
        counts = row_rle(mask)
        if len(counts) > 512001 or runs + len(counts) > 4_000_000:
            continue
        ys, xs = np.nonzero(mask)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
        regions.append({"id": f"{'guided' if box is not None else 'sam'}-{len(regions) + 1}", "bbox": bbox, "area": int(mask.sum()),
                        "segmentation": {"width": width, "height": height, "counts": counts}})
        runs += len(counts)
        if len(regions) >= (3 if box is not None else 256):
            break
    result = {"width": width, "height": height, "regions": regions, "model": MODEL,
              "device": torch.cuda.get_device_name(0), "elapsedMs": round((time.perf_counter() - started) * 1000)}
    # A guided crop or box must never masquerade as the cached automatic pass.
    if box is None:
        cached_key, cached_result = key, result
    return result


for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 15 * 1024 * 1024:
            raise ValueError("Detection request is too large.")
        message = json.loads(line)
        request_id = message.get("id")
        result = detect(message)
        output = {"id": request_id, "result": result}
    except Exception as error:
        print(f"Local detection: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        output = {"id": request_id, "error": str(error)[:700]}
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    print(json.dumps(output, separators=(",", ":")), flush=True)
