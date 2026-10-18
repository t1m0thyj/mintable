# Mintable v3 release candidate

Mintable imports balances and transactions from Teller or CSV files and exports them to Google Sheets or CSV. It runs on your computer or in an opt-in GitHub Actions workflow. Node 24 or newer is required.

**This fork is not published yet.** The checkout remains private for packaging until its repository and npm package identity are chosen. The original `mintable` npm package and `kevinschaich/mintable` repository belong to the original project; do not use them as this fork's release destination. The original author and MIT license remain credited in [LICENSE](./LICENSE).

## Try the local release candidate

From this checkout:

```bash
npm ci
npm test
npm pack
npm install --global ./mintable-3.0.0-rc.1.tgz
mintable setup
mintable fetch
```

On Windows PowerShell, use the same commands in the checkout directory. `mintable setup` guides you through Teller or CSV import and Google Sheets or CSV output. Keep the Teller certificate, private key, configuration file, and backups private.

Teller's sandbox uses test data. Development uses real bank data and currently allows up to 100 enrollments; production is a paid environment. This integration handles Teller's depository and credit account types when the account exposes transactions. Teller's API may omit balances for some accounts; institution and product coverage must be checked with the intended banks. See [Teller environments](https://teller.io/docs/guides/environments) and [account capabilities](https://teller.io/docs/api/accounts).

For CSV-only use, choose CSV import during setup. Google Sheets is optional. See the [full guide](./docs/README.md) for Google authorization, platform-specific scheduling, certificate renewal, connection repair, migration, rollback, and the opt-in GitHub Actions workflow.

## Release status

The v3 code and fixture tests are ready for local review. A public release still requires a fork repository and package name, a packed-install check on each target platform, and live Teller development validation against one depository and one credit statement using disposable output destinations. The [release checklist](./docs/release-v3.md) records those gates.
