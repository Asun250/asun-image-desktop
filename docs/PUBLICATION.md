# Publication policy

The owner authorizes publishing ASUN Image Desktop source, artwork/images, recorded prompts, reference material, editable saved projects and generated results. This replaces the earlier code-only restriction.

Never publish API keys, credentials, authentication/session data, private account details, active queue controls, runtime environments or unrelated personal files. Preserve original image and editable-project bytes; sanitize operational fields in exported job metadata.

After each completed app iteration, synchronize the intended tested changes into this checkout, preserve its portability adjustments, inspect the staged diff, run npm run check:public, commit and push to the designated repository. Keep the installed app intact and preserve repository visibility.

Large project collections belong in downloadable GitHub releases, with a catalog and recorded prompt files in project-library/. The exporter snapshots finished/cancelled/failed jobs, preserves missing legacy fields as not recorded and rejects active work or detected credentials. Do not copy the active data/ directory wholesale or restore runtime queue markers from an archive.

The optional SAM runtime is installed separately. No model downloads, GPU inference or paid generation calls were needed for publication.
