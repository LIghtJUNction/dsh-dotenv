# Upstream provenance

- Source: [https://github.com/narumiruna/pi-extensions/tree/a0e0079303415a1eb0eb58f68538a593c58182e5/packages/pi-dotenv](https://github.com/narumiruna/pi-extensions/tree/a0e0079303415a1eb0eb58f68538a593c58182e5/packages/pi-dotenv)
- Repository: https://github.com/narumiruna/pi-extensions
- Pinned commit: `a0e0079303415a1eb0eb58f68538a593c58182e5` (read from GitHub API before implementation).
- Package license: MIT, Copyright (c) 2026 narumiruna. Full upstream attribution and permission text are included in `NOTICE`.
- Reviewed actual sources: `src/index.ts`, `src/dotenv.ts`, and package LICENSE at the pinned commit.

## Migration differences

- Upstream `src/dotenv.ts` registers Pi's `--env-file` flag, reads synchronously, parses with Node `parseEnv`, and fills undefined environment values.
- DSH uses Schemastery `Config.path` (explicit opt-in) and `Config.root`, async bounded host-local reading, no symlinks/hardlinks, containment checks, startup cancellation/disposal and sanitized fixed errors.
- Preserves BOM handling, Node dotenv syntax and inherited-value precedence. Does not implement Pi flags, environment expansion, watchers, reload overwrite, shell execution, model tools, or remote world/sandbox injection.
- Initialization ordering matters: this plugin cannot retroactively reconfigure consumers that already read their environment. Successful environment values persist until process exit.

All filesystem access is host-local Node filesystem access. These are DSH-native migrations of the feature intent, not Pi extension compatibility wrappers. No Pi TUI or remote filesystem compatibility is claimed. Runtime target is DSH 0.2.1-rc.2 and Node 24+.
