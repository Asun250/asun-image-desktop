"""Explicit installation check: load the pinned model on CUDA; do not process images."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
runtime = Path(sys.argv[1]).resolve()
checkpoint = runtime / "checkpoints" / "sam2.1_hiera_base_plus.pt"
digest = hashlib.sha256()
with checkpoint.open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != "a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5":
    raise RuntimeError("SAM checkpoint SHA-256 does not match.")

sys.path.insert(0, str(runtime / "source"))
with contextlib.redirect_stdout(sys.stderr):
    import torch
    import torchvision
    from sam2.build_sam import build_sam2

    if torch.__version__ != "2.7.1+cu126" or torchvision.__version__ != "0.22.1+cu126":
        raise RuntimeError("The expected PyTorch 2.7.1 / TorchVision 0.22.1 CUDA 12.6 wheels are required.")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. Check the NVIDIA GPU and driver before installing local detection.")
    if not torch.cuda.is_bf16_supported(including_emulation=False):
        raise RuntimeError("This worker requires an NVIDIA GPU with native BF16 support.")
    model = build_sam2(
        "configs/sam2.1/sam2.1_hiera_b+.yaml",
        str(checkpoint), device="cuda", apply_postprocessing=False,
    )
    torch.cuda.synchronize()
    del model
    torch.cuda.empty_cache()

print(json.dumps({
    "python": platform.python_version(), "torch": torch.__version__,
    "torchvision": torchvision.__version__, "cuda": torch.version.cuda,
    "device": torch.cuda.get_device_name(0),
}))
