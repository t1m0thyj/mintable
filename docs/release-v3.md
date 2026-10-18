# Mintable v3 release candidate

Current candidate: `3.0.0-rc.1`. The package is marked `private` to prevent an accidental publish under the original `mintable` name. This checkout still has the original project's author and MIT attribution. Repository, issue tracker, and homepage fields have been removed until this fork has an owner and destination.

## Changes since v2

- Teller replaces Plaid for live bank import. CSV import remains available for unsupported institutions.
- Teller setup supports sandbox, development, and production with certificate and key validation. Account linking, multiple accounts per enrollment, and repair run through a local browser page.
- Teller transactions retain provider IDs, exact decimal strings, dates, currency, and pending state. Pagination and retries are bounded.
- Migration previews v1/v2 configuration, writes a separate pending v3 file, requires explicit account mappings and new output destinations, and keeps source backups. CSV reconciliation requires provider-qualified IDs and a reviewed month boundary.
- Google setup uses desktop loopback OAuth with state validation, PKCE, and offline access. Keyed Sheets rows preserve user formulas and annotations. CSV exports use full dates and spreadsheet-safe text. Local files are written atomically.
- Fetch stops without output changes on incomplete account retrieval. CI uses fixtures; the live workflow is opt-in.

## Local gates

Record results before promotion:

- [ ] `npm ci` succeeds on Windows, macOS, and Linux with Node 24 or newer.
- [ ] `npm test` passes on all three platforms.
- [ ] `npm pack --dry-run` includes the CLI, generated schema, docs, license, and no credentials.
- [ ] Install the tarball in a temporary prefix on all three platforms and run `mintable` and a fixture-backed CSV fetch from that install.
- [ ] Run a fresh CSV-only setup and fetch on all three platforms, including an absolute Windows CSV path.
- [ ] Review the root README and guide against the final package name and repository URL.

Windows local check on 2026-10-18: `npm ci` succeeded from a clean install, `npm test` passed 48 fixture tests, the tarball contained the CLI, generated schema, README, guide, and license with no PEM/key/config file, and a temporary-prefix install of that tarball completed a fixture-backed CSV fetch with two transactions. macOS and Linux runner results remain pending until CI runs in the chosen fork.

## Live development gates

Use a disposable Google spreadsheet or new CSV paths, and keep the old destination untouched.

- [ ] Confirm the intended institutions are available in Teller Connect and record any unsupported institution for CSV fallback.
- [ ] Link one depository and one credit account in Teller development. Verify the enrollment IDs and selected account IDs.
- [ ] Compare balances, transaction dates, amounts, signs, currency, pending state, and available history with statements for both accounts. Check withdrawals, deposits, card purchases, refunds, payments, and transfers where present.
- [ ] Fetch twice, then fetch a shorter range and verify keyed Google annotations or CSV history behavior. Test a disconnected enrollment or invalid certificate against disposable output; no output should change.
- [ ] Run the migration and rollback rehearsal described in the guide with copies of any real legacy data. Keep the old schedule disabled while the new schedule is active.
- [ ] Test the intended scheduler's certificate and key access. For GitHub Actions, set three secrets, run manual dispatch, inspect cleanup and output, then opt in to a schedule if desired.

## Publishing gates

1. Choose and create this fork's GitHub repository and npm package name. Verify publish rights to that scope. Never publish over the original `mintable` name or direct this fork's issue links to the original maintainer.
2. Update `package.json` name, repository, bugs, and homepage; update the lockfile and docs. Keep Kevin Schaich's author and MIT license attribution. Remove `private: true` only after all earlier gates pass.
3. Promote the prerelease version to `3.0.0`, rerun all tests and packed-install checks, and inspect the tarball for secrets. A public scoped package needs `npm publish --access public` and the scope owner's npm credentials; see [npm's scoped publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
4. Publish from the approved commit, create release notes and a v3 tag in the chosen fork repository, and verify the install instructions against the published artifact.

No live credentials or final publishing identity were available while this candidate was prepared. The local fixture suite cannot establish real institution coverage, production cost, or bank-specific sign behavior.
