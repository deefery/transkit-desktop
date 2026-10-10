# TransKit Desktop — maintained fork

## Identity

- Local project: `C:\_AI\projects\transkit-desktop`
- Fork: `deefery/transkit-desktop`
- Official upstream: `transkit-app/transkit-desktop`
- License: GPL-3.0-only (retain upstream license and notices)

## Git topology

- `origin` -> `https://github.com/deefery/transkit-desktop.git`
- `upstream` -> `https://github.com/transkit-app/transkit-desktop.git`
- Local `upstream` push URL is intentionally disabled.

### Branch roles

- `main`: clean mirror of official `upstream/main`. Do not place custom product commits here.
- `custom/main`: long-lived integration branch for our version.
- `feature/*`: normal feature/fix branches based on `custom/main`, merged back after review.
- `upstream-pr/*`: clean contribution branches based directly on `upstream/main`; cherry-pick only the minimal generally useful commits intended for an upstream PR.

## Upstream sync policy

Prefer merge-based synchronization for the published long-lived `custom/main` branch so we do not need routine force-pushes.

Typical sync:

```bash
git fetch --all --prune

git checkout main
git merge --ff-only upstream/main
git push origin main

git checkout custom/main
git merge upstream/main
# resolve only real conflicts, then run project validation
git push origin custom/main
```

If `main` cannot fast-forward to `upstream/main`, stop and inspect why. `main` is not supposed to contain our custom commits.

## Upstream contribution policy

Do not open upstream PRs from `custom/main`.

For a change worth contributing back:

1. Update local `upstream/main`.
2. Create `upstream-pr/<topic>` from `upstream/main`.
3. Cherry-pick or re-implement only the minimal upstream-worthy commits.
4. Run focused validation.
5. Open the PR against `transkit-app/transkit-desktop:main`.

This keeps our product-specific work out of upstream review and makes future synchronization easier.

## Product direction

The fork exists to improve TransKit as a low-friction language layer across Windows apps, especially selected-text workflows.

Near-term areas of interest:

- selected text -> translate with minimal UI friction;
- selected text -> pronounce / TTS for source or translation;
- first-class Chinese, English, Japanese, and Spanish switching;
- clean support for Edge TTS and OpenAI-compatible translation/TTS providers;
- optional no-cloud/private configuration;
- preserve upstream architecture where practical so upstream merges stay cheap.

## Engineering rules

- Prefer small, isolated changes over broad rewrites.
- Keep provider-specific logic behind existing abstractions where possible.
- Avoid unnecessary formatting churn in upstream-owned files.
- Keep secrets, API keys, account data, and local machine configuration out of Git.
- Before a large architectural divergence, first check whether the change can be made upstream-friendly or implemented as an extension point.
- Record deliberate deviations from upstream here or in a dedicated design note.
