# nuckty-ext-command-content-external

> **Populate the content root from external Git repositories — the `content-external` command.**

A command extension for [nuckty](https://github.com/nuckty/nuckty). It clones or updates Git repositories from the global `config/external.json` into `external/`. `nuckty build` reads the prepared files and does not run this command automatically.

Git must be in `PATH`; updates also require Git LFS for inspection, even when the repository has no LFS files.

## What it adds

One CLI command, registered through `env.commands`:

```
nuckty content-external [--dry-run]
```

- `--dry-run` — reports what would be cloned or updated without touching disk.

## How it works

1. Reads `config/external.json` — an array of git repo URLs.
2. For each URL, resolves the repo name (last path segment without `.git`).
3. An existing `external/<name>/` is updated only when it is the configured repository and its working tree is clean. GitHub HTTPS, SSH scp, and `ssh://` URLs for the same owner/repository are treated as the same identity; other hosts and different GitHub paths are not. Dirty, mismatched, or unverifiable copies are refused and left untouched.
4. `--dry-run` prints the plan (`would clone <name>` / `would update <name>`).

## Why a separate step

The build reads Markdown from configured content levels. It does not clone or fetch automatically; Git may also supply modification metadata. Offline and reproducible operation requires prepared files, fixed tool versions, and extensions that do not access the network.

Run `npx nuckty content-external` from the site root where the package is installed and listed in `ext`. `--dry-run` uses local Git checks but does not fetch, clone, or write.

The command accepts no target name and reads only the global `config/external.json`. A missing file or an empty array succeeds without preparing repositories. With separate target `configDir` values, keep their lists consistent with the global file.

