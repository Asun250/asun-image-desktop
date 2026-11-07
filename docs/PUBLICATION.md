# Code-only publication policy

Publish the ASUN desktop application source, dependency manifests, synthetic test code, launchers and concise setup/legal documentation only.

Do not publish images (including branding), personal prompts, reference packs, saved projects, generated outputs, credentials, runtime data or logs. Generic prompt-building functions are part of the application source and are distinct from user prompt records.

The code-only Git history starts from a clean root commit. The local working desktop installation is separate and retains its private assets and projects. Source publishing must not move, restart or overwrite that installation.

For every completed iteration:

1. Synchronize only the intended source changes into this checkout, preserving its portability adjustments.
2. Run appropriate local/mocked checks. Paid generation tests require separate authorization.
3. Inspect the staged diff and run npm run check:public.
4. Commit and push to the designated GitHub repository, preserving its visibility.
5. Report the commit and validation, or the specific authentication/access blocker.

The public-source check enforces allowed file types and private-data directory exclusions. Human/agent review remains necessary to detect private prompt text within otherwise permitted source files.

Optional SAM setup is opt-in. Its full provisioning sequence still needs validation on a clean Windows machine; no model downloads or GPU inference were performed for publication.
