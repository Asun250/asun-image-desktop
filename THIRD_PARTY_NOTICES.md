# Third-party notices

This source repository does not bundle Python environments, SAM weights, CUDA wheels, Node.js, or browser binaries. Optional setup and developer commands download dependencies from their respective upstream sources. Their licenses remain separate from any license for the app code.

## Optional SAM 2 runtime

**SAM 2** is by Meta Platforms, Inc. and contributors. This app uses SAM 2.1 Hiera Base Plus from commit `2b90b9f5ceec907a1c18123530e92e794ad901a4` of [facebookresearch/sam2](https://github.com/facebookresearch/sam2/tree/2b90b9f5ceec907a1c18123530e92e794ad901a4). The upstream [license statement](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/README.md#license) identifies the model checkpoints and project code under [Apache License 2.0](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/LICENSE). The installer preserves the upstream checkout and its notices. Model URL and checksum are recorded in [local detection setup](docs/LOCAL_DETECTION.md).

SAM's optional connected-components implementation derives from **cc_torch**, under its [BSD 3-Clause license](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/LICENSE_cctorch). Its source/license remain in the downloaded checkout; the Asun installer disables building that extension.

**PyTorch 2.7.1** is distributed under the terms in its [upstream license](https://github.com/pytorch/pytorch/blob/v2.7.1/LICENSE), retaining attribution to the listed PyTorch/Caffe2 contributors. **TorchVision 0.22.1** uses the [BSD 3-Clause license](https://github.com/pytorch/vision/blob/v0.22.1/LICENSE). CUDA-enabled wheels include additional upstream components and notices; the installed distributions retain those files.

Other Python dependencies are listed in [`scripts/sam2-requirements.txt`](scripts/sam2-requirements.txt). Their installed distributions carry their individual license metadata. Python itself is a separately installed prerequisite; its [license](https://docs.python.org/3/license.html) applies to that runtime.

## Developer tooling

**Playwright 1.58.2**, by Microsoft and contributors, uses [Apache License 2.0](https://github.com/microsoft/playwright/blob/v1.58.2/LICENSE). Its browser downloads carry their own licenses/notices. `package-lock.json` records the developer dependency tree; these dependencies and browsers are not committed here.

**Sharp 0.34.5**, by Lovell Fuller and contributors, is used by the branding tests under [Apache License 2.0](https://github.com/lovell/sharp/blob/v0.34.5/LICENSE). Its prebuilt packages include libvips and other libraries under their own terms. See the [sharp-libvips third-party notices](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md), including the LGPL terms for libvips, and the license files distributed with the installed packages.

## Images and external services

Images imported by users or obtained from external search results retain their respective rights and attribution requirements. Their presence in a project does not make them part of this source repository's license. API services and their generated outputs are subject to the relevant provider terms.
