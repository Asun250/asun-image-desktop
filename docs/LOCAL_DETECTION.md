# Optional local object detection

The editor works without SAM. Auto detect and guided detection use **Meta SAM 2.1 Hiera Base Plus** when its separate local runtime is installed. This is segmentation: it produces editable object outlines, not generated images or semantic object names.

## Requirements

- Native 64-bit Windows with PowerShell 5.1 or newer, Git, and 64-bit Python 3.12 available through `py -3.12`.
- An NVIDIA GPU with native BF16 support and a driver compatible with the PyTorch CUDA 12.6 wheels. The original installation used an RTX 3090 and Python 3.12.14; this does not establish compatibility with every GPU.
- Internet access during setup and several GB of free space for packages, source, weights, and package caches. The checkpoint is 323,606,802 bytes; the original complete runtime occupied about 5.7 GB.

The app's bridge currently expects Windows `env/Scripts/python.exe`. CPU inference, Apple Silicon, Linux, and WSL are not implemented by this installer. Upstream SAM recommends WSL for Windows; this app retains its existing native Windows setup and disables the optional CUDA extension. See the [pinned upstream installation guide](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/INSTALL.md).

## Explicit installation

From the repository root, run this only if you want local detection:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-LocalDetection.ps1
```

The script creates `local-ai/sam2/` beneath this repository. It refuses to overwrite a nonempty directory. It creates an isolated virtual environment, checks out the pinned SAM source, installs the recorded dependencies and CUDA wheels, downloads the checkpoint, checks its size and SHA-256, and loads the model on CUDA without processing an image. It writes `runtime.json` only after verification succeeds. The Python environment and downloads are excluded from Git.

Python is a prerequisite; the script does not install Python or change NVIDIA drivers. To use a specific Python 3.12 executable:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-LocalDetection.ps1 -Python 'D:\Tools\Python312\python.exe'
```

For a different runtime directory, use a new empty location and set the same path when launching the app:

```powershell
$env:ASUN_SAM_ROOT = 'D:\AsunData\sam2'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-LocalDetection.ps1 -RuntimeRoot $env:ASUN_SAM_ROOT
npm start
```

`ASUN_SAM_ROOT` is optional. Absolute paths are used directly; relative paths are resolved against the repository root, regardless of the shell's current directory. Set it in the environment that starts the Node server. Restart that server after setup or a path change. A desktop shortcut does not inherit variables set only in an unrelated terminal.

## Pinned components

| Component | Version or provenance |
| --- | --- |
| SAM source | [`facebookresearch/sam2`, commit `2b90b9f5ceec907a1c18123530e92e794ad901a4`](https://github.com/facebookresearch/sam2/tree/2b90b9f5ceec907a1c18123530e92e794ad901a4) |
| PyTorch / TorchVision | `2.7.1+cu126` / `0.22.1+cu126`, from the [official CUDA 12.6 wheel index](https://pytorch.org/get-started/previous-versions/#v271) |
| Other Python packages | [`scripts/sam2-requirements.txt`](../scripts/sam2-requirements.txt), versions recorded from the original installation |
| Checkpoint | [`sam2.1_hiera_base_plus.pt`](https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt) |
| Checkpoint SHA-256 | `a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5` |

The setup script was prepared for this public source copy without running a fresh installation or downloading packages/models. Its full provisioning path still needs validation on a clean Windows machine. The original installed runtime supplies the version record; it is not bundled or copied into this repository. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Operation and troubleshooting

Detection starts only after an explicit detection action. Working image bytes go to the local Python worker; the worker does not download models or accept image paths/URLs. Source images remain embedded in the editable `.asun` project. Detection uses working copies at most 1600 pixels per side and limits automatic output to 256 masks. Small, transparent, or overlapping objects can require manual selection.

The worker exits after three idle minutes to release GPU memory. The optional connected-components extension is disabled, so its tiny-hole/speck cleanup is unavailable.

If setup fails, the incomplete directory is left for inspection and has no successful installation manifest. Choose a new empty directory when retrying. Do not copy a virtual environment from another machine or move an installed runtime: recreate it at its final location because Python environments and editable package installations contain absolute paths.

To check an installed runtime explicitly, run the verifier below. It loads the model on the GPU, processes no image, and prints version/device metadata:

```powershell
.\local-ai\sam2\env\Scripts\python.exe .\scripts\verify-local-detection.py .\local-ai\sam2
```

An unavailable-runtime message usually means the directory, `runtime.json`, Python executable, source checkout, or checkpoint is missing. A CUDA/BF16 error means the GPU or driver does not meet this worker's requirements. A model hash failure requires a new verified download. Ordinary editing remains available when detection is unavailable.
