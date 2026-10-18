# Part 1 baseline (2026-10-18)

## Starting point

- Node 24.22.0, npm 11.19.1 on Windows. The repository had no installed dependencies or lockfile.
- The original dependency install completed. `npm run build` passed; `npm run lint` failed on eight existing files. The original resolved dependency tree reported 21 vulnerabilities (3 low, 3 moderate, 15 high).
- The migration plan was already present as an untracked file and was left intact.

## Reproducible setup

- Node 24 is the CI baseline; `engines.node` allows Node 24 and newer. The CI test job runs on Windows, macOS, and Linux.
- Use `npm ci` for a clean install. `npm test` compiles, checks formatting, and runs the fixture tests.
- `npm run build` generates `lib/common/config.schema.json` from the TypeScript `Config` type. Runtime configuration validation reads this packaged file with AJV; JSONC parsing remains supported. `npm pack` runs the build first.
- TypeScript uses an explicit ES2022/CommonJS target and staged strictness. `strictNullChecks`, `noImplicitAny`, and `strictPropertyInitialization` remain disabled while the legacy integration code is migrated.
- The dependency upgrades were applied by group: tooling and types, Google and AJV, HTTP/CSV/date utilities, then CLI packages. `open@7` and `chalk@4` are retained as CommonJS-compatible versions; converting the CLI to ESM is deferred.

## Verification

- On Windows, `npm ci`, `npm test` (six fixture tests), and a packed installation passed. The installed package can load its generated schema and contains the Teller account setup HTML.
- Fixtures cover transaction rules, Teller spending signs, inclusive date boundaries, CSV parsing, and configured CSV export columns and dates. They characterize current behavior; real Teller statements are still needed to verify sign mapping.
- The Windows/macOS/Linux CI matrix is configured but has not run in this checkout.
- `npm audit` now reports three high vulnerabilities, all in the legacy Plaid dependency chain (`plaid`, `axios`, `follow-redirects`). Removing that adapter and SDK is Part 3 of the migration. No other runtime or development finding was reported by the resolved-tree audit.
