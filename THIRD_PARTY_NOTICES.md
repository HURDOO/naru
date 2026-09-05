# Third-party notices

Naru is licensed under Apache-2.0. Its standalone distribution also contains third-party software
under compatible licenses. Each deployed package keeps its upstream package metadata and license
files in the artifact; this document is the top-level index, not a replacement for those terms.

## Reproducible dependency inventory

The production inventory is derived from the committed `pnpm-lock.yaml`:

```bash
pnpm licenses list --prod --json
```

The 2026-09-05 v0 freeze reported 253 package names in these groups:

| SPDX expression         | Package names |
| ----------------------- | ------------: |
| MIT                     |           228 |
| ISC                     |             9 |
| BSD-3-Clause            |             6 |
| Apache-2.0              |             2 |
| BlueOak-1.0.0           |             5 |
| BSD-3-Clause OR GPL-2.0 |             1 |
| 0BSD                    |             1 |
| MPL-2.0                 |             1 |

`node-forge` is dual-licensed under BSD-3-Clause or GPL-2.0; this distribution uses the
BSD-3-Clause option. `web-push` is MPL-2.0 and remains an unmodified dependency rather than copied
Naru source. The exact names, versions, authors and upstream homepages are available from the
command above and from each bundled package's metadata.

## Bundled runtime and assets

- Node.js v24.20.0 is bundled from the official darwin-arm64 archive. Its upstream `LICENSE` and
  source metadata are stored at `runtime/node/LICENSE` and `runtime/node/source.json` in the
  standalone artifact.
- D2Coding font files are distributed under SIL Open Font License 1.1. The full text is retained at
  `apps/web/public/fonts/d2coding/OFL.txt` in source and in the built web payload.

Dependencies and their licenses can change with `pnpm-lock.yaml`. Regenerate and review the
production inventory whenever that lockfile changes; do not infer approval from this frozen count.
