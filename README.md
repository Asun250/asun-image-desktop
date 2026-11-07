# ASUN Image Desktop

ASUN IMG is a local desktop image editor with reference-guided image generation, editable projects, object selections, sketching, character/item sheets, and a background job queue. The desktop window uses Microsoft Edge or Google Chrome and a Node.js service bound to `127.0.0.1`.

This repository contains the current 1.6.7 desktop application, its artwork, and the owner's authorized project library: images, references, recorded prompts, editable projects and generated results. It is separate from the hosted phone app and ChatGPT plugin. Credentials and private account/runtime records are excluded.

## Run on Windows

Install **Node.js 24 LTS**, then clone or download this repository:

```powershell
git clone https://github.com/Asun250/asun-image-desktop.git
cd asun-image-desktop
& '.\Launch Asun IMG.ps1'
```

If your PowerShell policy prevents running local scripts, use the terminal alternative:

```powershell
npm start
```

Open **http://127.0.0.1:48010** in your browser. The launcher searches ports 48010–48019 and can reuse an existing ASUN desktop instance. To run a separate copy, choose a free port explicitly:

```powershell
$env:ASUN_PORT = '48020'
npm start
```

There are no production npm dependencies. `npm ci` installs the development/test dependencies only. Windows is the supported desktop target; native branding and the optional detection worker are Windows-specific. The app branding, startup animation and taskbar artwork are included.

## Image generation

Configure your own **OPENAI_API_KEY** in your Windows user environment, then restart the local app service. Alternatively, provide it through your terminal environment. The service reads the key server-side; never add a key to this repository, frontend files, screenshots, or saved public examples. A `.env` file is not loaded automatically.

Use **Check connection** in the app to verify access. Availability depends on the connected provider account. Generation and AI removal/fill incur API charges; local drawing, masking, reference packs and project editing do not require a generation call.

The existing model selector includes GPT Image 2.6 Sunburst and Flare, the 2.5 models, and earlier supported choices. The app validates model-specific quality, aspect-ratio and complexity options and reports unsupported requests. Provider access and capabilities may change; see the recorded settings in each result and the [OpenAI image-generation documentation](https://developers.openai.com/api/docs/guides/image-generation).

- **Quality** controls rendering quality and defaults to `high`.
- **Complexity** is separate planning effort for the 2.6 models: low, medium or high; default `high`.
- **Aspect Ratio** controls the request parameters. Unsupported remembered preferences require an explicit supported selection. Selected-area edits retain their source canvas by default.
- Results show the exact prompt, input images, requested settings and actual returned dimensions. Downloads retain the original generated file.

This publication adds no paid generation tests. Existing recorded prompts and results are available in the [project library](project-library/README.md). Older jobs without saved prompts are labeled accordingly.

## Workflows included

- Image import, web search, paste and drag-and-drop; multiple composition/reference photos.
- Pencil, highlight, text, masks, layer transforms, canvas rotation, undo/redo and editable `.asun` projects.
- Optional local SAM 2 detection, highlighted-object detection, grouped areas and the complete reference editor.
- Draw/sketch reference workspace and seven- or nine-view character/item sheets.
- Reference ZIP packs with original images, annotations, region mappings and instructions.
- Background generation jobs, workflow tabs, generation history, result inspection, edit-output and redo-with-source actions.
- Optional blockout review and scene-consistency guidance. Raster comparison does not certify exact 3D dimensions.

## Optional local object detection

Auto detect uses a separate **SAM 2.1** installation on a supported NVIDIA GPU. Python, PyTorch and the model checkpoint are not bundled in Git. Manual selection and the rest of the editor remain available without it.

Follow [Local detection setup](docs/LOCAL_DETECTION.md). The opt-in setup downloads several gigabytes; it does not run during normal application startup or `npm ci`.

## Projects and privacy

Save portable editable projects as `.asun` files. These files can contain original photos, references, prompts and annotations. Browser draft recovery is local to that browser profile. Generated jobs, inputs and results are stored in the local `data/` directory; logs go in `logs/`.

Authorized saved projects, original/reference images, prompts and generated results are published as a [project-library release](https://github.com/Asun250/asun-image-desktop/releases/tag/project-library-2026-11-06). The repository contains its browsable catalog and prompt files. The release preserves original image and editable-project bytes. Credentials, private account data, operational queue markers, local logs, Python environments and downloaded models are excluded. Do not expose this local service directly to the internet.

## Development

```powershell
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run check:public
```

Unit/service tests use mocked provider responses. GPU/native-window checks require explicit opt-in and local prerequisites. Artwork-dependent checks skip if optional artwork is absent. See [Development and verification](docs/DEVELOPMENT.md).

After each completed iteration, test and commit the intended code and authorized material changes, run `npm run check:public`, and push to this repository. Use the sanitized snapshot exporter for saved project collections. Inspect staged content for credentials and unrelated private data; automated checks are an aid, not a substitute for review. Preserve the repository visibility.

Application modules live in `public/`, the loopback service in `server.mjs`, generation integrations in `desktop-*.mjs`, the local detection bridge in `local-sam.mjs` / `local-sam-worker.py`, and native desktop helpers in `windows/`.

## Licensing

This source is publicly viewable. No open-source license grant has been selected for ASUN application code or its branding; GitHub visibility alone does not grant general redistribution rights. Third-party components retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).
