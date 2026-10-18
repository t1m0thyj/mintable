# Mintable v3 guide

Mintable needs Node 24 or newer. This fork is a local release candidate until its repository and npm package identity are chosen. Install the packed checkout as described in the [root README](../README.md); the existing `mintable` npm package belongs to the original project.

## First run

Run `mintable setup`, choose Teller or CSV import, and choose Google Sheets or CSV export. Then run `mintable fetch`. The default configuration is `~/mintable.jsonc`. Use `--config-file /absolute/path/config.jsonc` with every command if you keep it elsewhere. `--config-variable NAME` reads JSONC from an environment variable for commands that do not modify configuration; setup and token refresh need a writable file. A relative `--config-file` path resolves from the current directory. Teller certificate paths in a file configuration resolve from that configuration file's directory, and `~` expands to your home directory. Absolute Windows paths work on Windows.

The configuration contains Teller enrollment tokens and possibly Google refresh tokens. Keep it and its backups private. Mintable writes configuration files atomically with private permissions where the operating system supports them.

## Teller connection and coverage

Create a Teller application and obtain its application ID, client certificate, and private key. Run `mintable teller-setup` to select sandbox, development, or production and enter those paths. Run `mintable account-setup` to open the local linking page. Link institutions, select the desired accounts, then select **Done linking accounts**. `mintable teller-account-setup` is an alias. Add `--port=8000` if you need a particular local port.

Teller's [sandbox](https://teller.io/docs/guides/environments) has simulated data. Development connects to real banks, is currently free, and has a 100-enrollment limit. Production connects to real banks and is paid. A single enrollment can contain several accounts. Mintable handles Teller [depository and credit account types](https://teller.io/docs/api/accounts). It requires a transactions link for each selected account and uses balances when that link is available. Institution support and historical coverage vary; verify your intended checking, savings, and credit accounts during development. Older than six months of transactions may be unavailable. Mintable keeps older previously exported Teller months when a later fetch returns less history.

If the certificate expires or is replaced, obtain the replacement from Teller, update the certificate and key paths with `mintable teller-setup`, then run a fetch against a disposable destination. The certificate and key must match. On a scheduler, ensure the scheduler's user can read both files. `TELLER_CERTIFICATE_FILE` and `TELLER_PRIVATE_KEY_FILE` override configuration paths for that process. To repair a disconnected enrollment, run `mintable account-setup` and choose **Repair connection**. Removing an account from Mintable removes its local configuration; revoke bank access separately through Teller when needed.

## CSV fallback

Choose CSV import during `mintable setup`, or run `mintable csv-import-setup` later. Point it at statement files or a glob, then edit that account's `transformer` in the config to map source headers to `date`, `amount`, and `name`. Set `dateFormat` to the source file's actual format, such as `MM/dd/yyyy`. Templates in [`docs/templates`](./templates) illustrate common mappings. A missing file, invalid date, or invalid amount stops the fetch before any output changes. Use CSV for a bank that Teller does not support, and check for duplicate transactions if you also import the same account through Teller.

Choose CSV export or run `mintable csv-export-setup` for local output. Set distinct transaction and balance CSV paths. Transaction dates default to `yyyy-MM-dd`; amounts remain numeric CSV fields. Text that spreadsheet software could interpret as a formula receives a leading apostrophe. Exports replace files atomically. For a complete history across a migration boundary, use the reconciliation workflow below.

## Google Sheets

Run `mintable google-setup` after creating a spreadsheet. Enable the Sheets API in your Google Cloud project and create a **Desktop app** OAuth client. The wizard opens a browser and listens on a temporary `127.0.0.1` callback port. It validates state, uses PKCE, and requests offline access. If access is revoked or expires, run `mintable google-setup` again. Configure the consent screen for its actual audience. An External app left in Testing receives a seven-day refresh token for the Sheets scope, so unattended use requires the appropriate publishing configuration. See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [token expiration rules](https://developers.google.com/identity/protocols/oauth2).

Mintable owns the configured transaction and balance columns plus `_mintable_key`. Put formulas and annotations to the right of that key. Repeated fetches keep a transaction's row stable; removed generated rows retain a retired key and user columns for review. A partial-month fetch merges with stored rows. A complete month can retire absent generated rows for accounts fetched successfully. Historical Teller months and transactions from removed accounts remain. An old unkeyed sheet needs a new destination or a reviewed conversion before this writer changes it. Same-spreadsheet templates must already have the keyed layout; precreate cross-spreadsheet templates in the destination. `monthTabFormat` controls tab names, and `transactionDateFormat` controls full dates; their defaults are `yyyy.MM` and `yyyy-MM-dd`.

## Scheduling

Run one manual `mintable fetch --config-file ABSOLUTE_CONFIG_PATH` successfully before scheduling. Keep the machine online and the certificate paths accessible to the scheduled user.

### Windows Task Scheduler

Run `where.exe mintable` in PowerShell and note the absolute executable path. Open **Task Scheduler** → **Create Basic Task**, choose a daily or other interval, select **Start a program**, set **Program/script** to that executable path, and set **Add arguments** to `fetch --config-file "C:\path\to\mintable.jsonc"`. In task properties, choose the intended user account and a working directory if you rely on relative CSV paths. Test with **Run**, then inspect **Last Run Result** and your output files. [Microsoft's Task Scheduler documentation](https://learn.microsoft.com/en-us/windows/win32/taskschd/schtasks) describes the available schedules and diagnostics.

### macOS and Linux

Use `command -v mintable` to find the executable. Add a cron entry with absolute executable and config paths, for example:

```text
0 8 * * * /absolute/path/to/mintable fetch --config-file /absolute/path/to/mintable.jsonc
```

Run the same command manually as the scheduled user. A cron environment has a smaller `PATH` than an interactive shell. Keep the config, certificate, and key readable by that user.

### Opt-in GitHub Actions

The `Test` workflow runs fixture-only checks on pushes and pull requests. The `Fetch` workflow runs only on manual dispatch until a maintainer enables its commented schedule on the default branch. It allows one live fetch at a time. Configure these repository secrets for a Teller fetch:

| Secret | Value |
| --- | --- |
| `MINTABLE_CONFIG` | Full v3 JSONC configuration; use a disposable Google or CSV destination for initial validation. |
| `TELLER_CERTIFICATE_PEM` | Entire client certificate PEM. |
| `TELLER_PRIVATE_KEY_PEM` | Entire matching private key PEM. |

The workflow writes all three secrets to private temporary files, sets the Teller path overrides, and removes them when the fetch ends. The config file in a runner is temporary, so a newly rotated Google refresh token is not saved back to the repository secret. Reconnect locally and update `MINTABLE_CONFIG` if unattended Google authorization stops working. A remote runner needs network access to Teller and Google; CSV destinations on its local disk are ephemeral. Use Google Sheets for durable cloud output.

## Migrating existing data

Keep the old program, configuration, and outputs until the new destination is reviewed. Plaid credentials cannot be reused as Teller credentials. Mintable v3 imports from Teller or CSV.

Preview conversion without modifying the source:

```bash
mintable migrate --source-file /absolute/old/mintable.jsonc --output-config-file /absolute/new/mintable.v3.jsonc
```

Review the preview and apply with its hash:

```bash
mintable migrate --source-file /absolute/old/mintable.jsonc --output-config-file /absolute/new/mintable.v3.jsonc --apply --expect-sha256 REVIEW_HASH
```

For an environment-based old config, use `--source-env MINTABLE_CONFIG` instead of `--source-file`. Apply writes a separate pending v3 file and private backups. It does not change the original. Configure Teller against the new file with `mintable teller-setup --config-file NEW_FILE`, then use `mintable account-setup --config-file NEW_FILE`. The pending config cannot fetch.

Create an account mapping JSON file. Every legacy account needs a stable local ID and an explicit Teller or CSV target, or `archive`:

```json
{
  "plaid:old-checking": { "localAccountId": "checking", "target": "teller:acc_new_id" },
  "plaid:unsupported": { "localAccountId": "unsupported", "target": "archive" },
  "csv:Manual": { "localAccountId": "manual", "target": "csv:Manual" }
}
```

Choose a new output destination. For Google, duplicate the old spreadsheet as an archive and create a separate empty destination. Review formulas and account/category references in the new spreadsheet. The existing Sheets scope cannot copy a whole spreadsheet through Drive. Preview activation:

```bash
mintable migrate --activate --config-file NEW_FILE --account-map-file MAP_FILE --cutover-month 2026-11 --new-google-sheet-id NEW_ID --google-archive-id ARCHIVE_ID --reviewed-formulas --empty-google-destination
```

For CSV output, replace the Google options with `--new-transactions-csv ABSOLUTE_NEW_TRANSACTIONS.csv --new-balances-csv ABSOLUTE_NEW_BALANCES.csv`. Apply activation by repeating the preview with `--apply --expect-sha256 CONFIG_HASH`. Check the first new fetch in the disposable destination against statements before making it your regular output.

To build a continuous CSV history, export old and new transactions with full dates, `accountId`, and `transactionId`. Mintable blocks automatic reconciliation when IDs or a complete-month boundary are missing. Record reviewed local account IDs in a JSON file:

```json
{ "cutoverMonth": "2026-11", "localAccountIds": ["checking"] }
```

Run `mintable reconcile --old-csv OLD.csv --new-csv NEW.csv --account-map-file MAP_FILE --complete-month-file COMPLETE.json --output-csv MERGED.csv --cutover-month 2026-11`. Review the preview, then add `--apply --expect-sha256 REVIEW_HASH`. Reconciliation writes a new file and preserves both inputs. Google annotations and formulas need a separately reviewed export/import.

### Rollback check

Before cutover, run the old version once against a **copy** of its old configuration and output. Then run the new version against its distinct destination. Confirm the old output has not changed during the new fetch. To roll back, disable the new schedule, restore the old schedule and old program, and use the unchanged old config and original output. Do not point either writer at the other's destination. The migration tests exercise pending-state blocking, backups, distinct destinations, activation, and unchanged old files; the live rollback rehearsal still requires your actual data and credentials.

## Development and release

Run `npm ci`, `npm test`, and `npm pack --dry-run`. The fixture suite has no bank credentials. The [release checklist](./release-v3.md) covers packed installs, live depository and credit comparison, repository and package identity, and publication. This fork preserves the original project's [MIT attribution](../LICENSE).
