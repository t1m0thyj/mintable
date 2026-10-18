# Part 3: Teller default setup

`mintable setup` now creates v3 configuration, chooses Teller or CSV import, and chooses Google Sheets or CSV export. A CSV-only install does not need Teller credentials. Teller setup defaults to development, labels real-data environments, and supports sandbox without certificate files.

`mintable account-setup` starts a loopback-only server on an available port, then opens the browser. `--port=PORT` selects a port. The browser receives a random session credential in the URL fragment; mutating requests require that credential plus matching Origin and Host. It passes Teller Connect the configured environment and balance/transactions products. Repair uses the saved enrollment ID. The server checks that account selections belong to the active Teller enrollment.

A v3 config stores each Teller token once in `enrollments`; each account stores an account ID, enrollment ID, and display label. The browser account list and enrollment account selection contain no saved token. Removing an account changes Mintable's local config only. Done resolves the command after server shutdown; Cancel rejects and closes it.

The Plaid adapter, setup pages, SDK dependency, and active types are removed. `plaid-setup` explains the change without loading Plaid. The old `migrate` command is disabled pending Part 4's preview-first migration. Existing Teller fork configurations are not upgraded, per the project decision.

Verification: `npm test` (23 tests), `npm ls plaid --depth=0`, and `npm pack --dry-run` with a local cache. No live Teller enrollment or Google OAuth login was performed. Teller Connect options and enrollment shape follow the [official Teller Connect guide](https://teller.io/docs/guides/connect); account ownership uses the [Accounts API](https://teller.io/docs/api/accounts).
