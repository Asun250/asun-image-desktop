# Development and verification

Use Node.js 24. Install development dependencies with `npm ci`. The app has no production npm dependencies; Playwright and Sharp are test tools. Install the Chromium test browser once with `npx playwright install chromium`.

## Architecture

- `server.mjs` serves the desktop web interface and local API on loopback. It accepts injected services, so tests can use temporary storage and mock providers.
- `public/core.mjs` defines editable projects, assets, layers, annotations and references. Rendering, selection, reference packs and editor UI live in the other `public/` modules.
- `desktop-sheet-service.mjs` handles provider requests, image/sheet records and result files. `desktop-image-request.mjs` builds image-generation requests. Browser-side generation settings and request modules preserve the chosen options.
- `desktop-generation-queue.mjs` persists queued jobs. Workflow session modules retain separate editor tabs and undo histories.
- `local-sam.mjs` and `local-sam-worker.py` provide optional local segmentation. See [Local detection setup](LOCAL_DETECTION.md).
- `windows/` contains optional Windows window-branding helper code. Branding images are included. The PowerShell launcher opens the app in an installed browser's app window.

## Tests

Run from the repository root:

```powershell
npm run check
npm test
npm run test:browser
```

`npm test` runs the Node unit and service tests in `tests/*.test.mjs`. Provider tests inject fake API responses and temporary directories. They do not generate paid images. Browser tests use isolated browser contexts and local ephemeral ports; they should not use the installed desktop app's running server.

`package.json` lists focused test commands for references, annotation, editing, masks, queue persistence, workflow tabs and output inspection. Hardware-dependent SAM tests and native Windows taskbar tests are optional and have additional prerequisites. Use only the specific suite needed for a change; do not run every standalone file as an undifferentiated test glob.

GPU integration suites require `ASUN_RUN_GPU_TESTS=1` and an installed SAM runtime. `ASUN_GPU_FIXTURE` can point to an image you deliberately choose for testing; otherwise synthetic fixtures are used. Grouped live detection checks use `ASUN_TEST_BASE_URL` when supplied. Native-window checks require Windows and `ASUN_RUN_NATIVE_TESTS=1`; `ASUN_EDGE_PATH` can select a nonstandard Edge installation. These opt-in checks can load the GPU or open a test window and are outside the default test commands.

Historical performance comparisons are optional: `ASUN_RETENTION_BASELINE_DIR` and `ASUN_GLOBAL_REFS_BASELINE_DIR` select a separately available baseline source tree. Normal tests do not require an older private release.

No live paid generation test is required by the default verification commands. A live provider test must be separately authorized and must disclose its model, settings and expected cost. API credentials must never appear in fixtures, logs, screenshots or committed files.

## Synthetic performance diagnostics

```powershell
node tools/diagnostics/heavy-history-benchmark.mjs
```

This benchmark creates synthetic drawing histories and compares session persistence modes. It uses an isolated local server with inactive generation, image-search and detection services; external browser requests are blocked. It verifies that the saved history restores with all 60 entries and reports capture time, total time and event-loop gaps. Results are machine-dependent diagnostics, not fixed performance guarantees. Output is written under ignored `qa/diagnostics/`.

The separate `npm run benchmark:workflow-storage` command measures synthetic large-image session storage. Neither benchmark reads saved user projects or calls an image provider.

## Published source scope

The repository contains the current desktop implementation, artwork, regression test code, launchers and runtime setup instructions. The authorized project library publishes images, prompts, editable projects and generated results through a sanitized export and release archive. Raw runtime folders, credentials, generated QA logs, downloaded model weights, environments and deployment backups remain excluded. Tests use synthetic fixtures; optional artwork tests skip when those files are absent.

Historical `qa/` scripts were reviewed before publication. Copies of old implementation/test baselines and one-off live installation checks were omitted: their current reusable counterparts are in `public/` and `tests/`. A prior live portrait-generation script was bound to a private saved job and is intentionally not a public test command. The reusable heavy-history benchmark was retained and isolated under `tools/diagnostics/`.

Keep future diagnostics synthetic or explicitly opt-in. Save their generated output below ignored `qa/`, never beside tracked fixtures or application source.

## Exporting the authorized project library

Use `scripts/export-project-library.mjs` when all stored jobs are completed, failed or cancelled. It reads the desktop data directory, copies original images and native projects unchanged, exports recorded prompts/settings, and omits authentication and live queue/process records.

```powershell
node scripts/export-project-library.mjs --source 'D:\Asun\data' --out 'D:\Exports\new-snapshot' --catalog 'D:\Exports\new-catalog'
```

Both destinations must be new or empty. The exporter refuses overlapping source/output locations, links, unfinished jobs, detected credentials or files that change during the snapshot. Its manifest records every exported content file's size and SHA-256. Missing legacy source projects/prompts remain explicitly absent.

Review the export, place its catalog and prompt files in `project-library/`, archive the full snapshot, and upload the archive as a versioned GitHub release asset. Verify the archive against its manifest and the uploaded asset's checksum. Commit the catalog/download metadata and source updates; do not place raw live `data/`, submission markers or credentials in Git. Original image metadata remains intact, so inspect authorized images before publication as well.
