# Mintable documentation

Mintable imports balances and transactions through Teller or CSV files, then exports to Google Sheets or CSV files. Use Node 24 or newer.

## Fresh setup

```bash
npm install -g mintable
mintable setup
mintable fetch
```

The wizard asks whether to connect banks with Teller or use CSV files only, then asks for Google Sheets or CSV output. Teller development and production connect to real bank data; sandbox uses test data. Development is the default. Teller development and production require a client certificate, private key, and application ID. The CSV-only option requires no Teller account.

The account linking page opens in your browser after its local server starts. It lists linked accounts, lets you link additional institutions and choose multiple accounts from each enrollment, and offers a **Repair connection** action for an existing enrollment. Select **Done linking accounts** to finish, or **Cancel setup** to stop. The local server uses an available port by default; use `mintable account-setup --port=8000` to choose one. Removing an account only removes its local Mintable configuration. To revoke bank access, use Teller's own controls separately.

## Commands

- `mintable setup`: create a fresh v3 configuration.
- `mintable teller-setup`: edit Teller application settings.
- `mintable account-setup`: link, repair, or remove Teller accounts. `teller-account-setup` is an alias.
- `mintable csv-import-setup`: add a CSV account.
- `mintable csv-export-setup`: select CSV output.
- `mintable google-setup`: select Google Sheets output.
- `mintable fetch`: fetch accounts and update the selected output.

Plaid is no longer a live provider. Existing Plaid credentials cannot be reused as Teller credentials. See [Migrating existing data](#migrating-existing-data) before using an old configuration with v3.

## Configuration example

A fresh CSV-only setup can produce a configuration shaped like this (the wizard adds CSV import and export details):

```json
{
  "version": 3,
  "integrations": {},
  "enrollments": {},
  "accounts": {},
  "transactions": { "integration": "csv-export", "properties": ["date", "amount", "name", "account", "category"] },
  "balances": { "integration": "csv-export", "properties": ["institution", "account", "type", "current", "available", "limit", "currency"] }
}
```

A Teller account references an `enrollmentId` in `enrollments`. The enrollment holds the access token once. Treat your configuration and backups as private credentials.

## Migrating existing data

`mintable migrate` accepts v1, v2 Plaid, v2 Teller fork, and mixed configurations. It never uses Plaid's SDK or relabels Plaid tokens. The first command only previews the conversion. It shows a review hash without printing credential values:

```bash
mintable migrate --source-file /path/to/old/mintable.jsonc --output-config-file /path/to/new/mintable.v3.jsonc
```

Review the retained integrations, accounts, columns, rules, backup paths, and warnings. Then apply the exact preview:

```bash
mintable migrate --source-file /path/to/old/mintable.jsonc --output-config-file /path/to/new/mintable.v3.jsonc --apply --expect-sha256 REVIEW_HASH
```

For a configuration in an environment variable, use `--source-env MINTABLE_CONFIG --output-config-file /path/to/new/mintable.v3.jsonc`. The output file is required; Mintable does not change the parent environment. Apply writes a separate v3 file atomically and makes private source and existing CSV output backups. Running the same apply again is safe when the preview is unchanged. Keep the old program and configuration until you have verified the new output. Backups may contain live bank and Google credentials, so keep them private.

The new v3 file begins in `pending` state. `mintable fetch` will refuse to export from it. Configure Teller with `mintable teller-setup --config-file=/path/to/new/mintable.v3.jsonc`, then link accounts with `mintable account-setup --config-file=/path/to/new/mintable.v3.jsonc`. CSV import accounts, export settings, transaction rules, templates, and custom columns are carried forward. Plaid accounts need Teller reconnection. A Teller fork account with no recoverable enrollment ID is listed for reconnection. An unsupported bank account can remain in the old archive or be represented through CSV.

Create an account mapping JSON file. Give each old bank or CSV account a stable local identity and a new target, or mark it `archive` if it will not be imported. This makes keeping a legacy CSV source alongside Teller an explicit choice:

```json
{
  "plaid:old-account-id": { "localAccountId": "checking", "target": "teller:acc_new_id" },
  "plaid:unsupported-id": { "localAccountId": "legacy-only", "target": "archive" },
  "csv:Manual": { "localAccountId": "manual", "target": "csv:Manual" }
}
```

Choose a **new destination** for Teller output. If the old output is Google Sheets, manually duplicate the original spreadsheet as an archive, create a separate empty destination spreadsheet, and review formulas and account/category references. The existing Google authorization only requested a Sheets scope; copying a whole file through Drive requires a Drive scope, so Mintable asks for the archive copy's ID instead of attempting an incomplete copy. [Google Drive's file-copy scope requirements](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy). Mintable checks that the three IDs differ, but you must verify that the archive is a complete copy and that the new destination is empty.

Preview activation with all mappings and destinations:

```bash
mintable migrate --activate --config-file /path/to/new/mintable.v3.jsonc --account-map-file /path/to/account-map.json --cutover-month 2026-11 --new-google-sheet-id NEW_ID --google-archive-id ARCHIVE_ID --reviewed-formulas --empty-google-destination
```

For CSV output, replace the Google options with `--new-transactions-csv /absolute/new-transactions.csv --new-balances-csv /absolute/new-balances.csv`. Both paths must be new and distinct. To apply activation, repeat the preview command with `--apply --expect-sha256 CONFIG_HASH` from its output. Activation backs up the pending v3 config before changing it. The original Google sheet, CSV outputs, legacy config, and backups remain unchanged. Use the new v3 config with `--config-file` only after inspecting the new destination. To roll back, use your old Mintable version and unchanged legacy config and output.

For a **continuous CSV history**, export both histories with full dates, `accountId`, and `transactionId` columns. The old defaults often omitted IDs; Mintable will block automatic reconciliation if they are absent. Set a complete-month boundary after the final month represented in the old output. Record your review of every active account in a separate JSON file:

```json
{ "cutoverMonth": "2026-11", "localAccountIds": ["checking"] }
```

Run `mintable reconcile` with `--old-csv OLD.csv --new-csv NEW.csv --account-map-file account-map.json --complete-month-file complete.json --output-csv merged.csv --cutover-month 2026-11`. The preview reports ignored new rows before cutover, possible cross-provider matches, and blockers. Apply using `--apply --expect-sha256 REVIEW_HASH`. The output is a new CSV with stable `mintableLocalAccountId` and provider-qualified `mintableSourceKey` columns. Mintable never treats matching date, amount, and description as proof of identity, never merges an overlapping month automatically, and never overwrites either input. Import the reviewed result into a separate destination; do not point the old monthly writer at it. Google history requires a separately reviewed export/import because formulas and annotations may depend on row positions.

## Importing account balances and transactions

### Teller

Run `mintable teller-setup` to set the environment and application credentials, then `mintable account-setup` to connect banks. Teller Connect requests the `balance` and `transactions` products. You can repair a disconnected enrollment from the same account setup page.

### Manually – on your local machine – via CSV bank statements

You can run:

```bash
mintable csv-import-setup
```

to enter the CSV import setup wizard. This will allow you to manually import files or globs (`path/to/my/folder/transactions/*.csv`) every time `mintable fetch` is run.

You'll need to define a transformer to map properties in your source CSV spreadsheet to valid Mintable transaction properties, and a valid date format.

We have a number of templates available for popular financial institutions to get you started:

- [Apple Card](./templates/apple-card.json)
- [Discover Card](./templates/discover-card.json)
- [Venmo](./templates/venmo.json)
- [Chase](./templates/chase.json)
- [American Express](./templates/american-express.json)
- [Rogers Bank Credit Card](./templates/rogers-bank-credit-card.json)

These templates can be added into the `accounts` section of your `mintable.jsonc` configuration file.

> **Note:** CSV Imports do not support account balances.

---

## Exporting Account Balances & Transactions

### In the cloud – via [Google Sheets](https://www.google.com/sheets/about/)

You can run:

```bash
mintable google-setup
```

to enter the Google Sheets setup wizard. This will allow you to automatically update a sheet with your transactions/account balances every time `mintable fetch` is run.

> **Note:** Google Sheets is the default export integration and this step is not necessary if you've already run `mintable setup`.

Create a **Desktop app** OAuth client and enable the Sheets API in its Google Cloud project. `mintable google-setup` opens the system browser and receives the callback on `127.0.0.1`; it requests offline access and stores the refresh token in the configuration file. For unattended use, configure the consent screen for your actual audience and publish an External app to Production when ready. An External app left in Testing receives a seven-day refresh token for the Sheets scope. If the token expires or is revoked, run `mintable google-setup` again. See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2).

Mintable owns the configured transaction and balance columns plus the `_mintable_key` column. Put formulas and annotations **to the right** of this key. Existing keyed transactions keep their row on later fetches, so these cells stay with the same transaction. Obsolete rows have only Mintable-owned cells cleared and retain a retired key; their user columns remain for review. A partial month's fetch merges new rows with stored keyed rows. Only a month fetched from its first through last day for every configured account retires missing rows; history from removed accounts stays in place. Teller months older than five months before the current month also merge because older provider history may be incomplete. An incomplete account fetch stops before any export. Existing unkeyed sheets require a new destination or a reviewed conversion before this writer will change them. A same-spreadsheet template must have the keyed column layout; cross-spreadsheet templates must be precreated in the destination.

`monthTabFormat` controls tab names (default `yyyy.MM`); `transactionDateFormat` controls full transaction dates (default `yyyy-MM-dd`). The older `dateFormat` setting remains an alias for month tab names. Generated text is written as literal text and amounts as numbers. CSV exports also default to full dates and prefix text that spreadsheet software could interpret as formulas.

### On your local machine – via CSV files

You can run:

```bash
mintable csv-export-setup
```

to enter the CSV export setup wizard. This will allow you to manually export a CSV containing your transactions/account balances every time `mintable fetch` is run.

---

## Updating Transactions/Accounts

### Manually – in your local machine's terminal

After you have connected a banking institution, you can run:

```bash
mintable fetch
```

to automate updates to your spreadsheet.

### Automatically – in your Mac's Menu Bar – via [BitBar](https://github.com/matryer/bitbar#get-started)

You can put Mintable in your Mac's menu bar, and have it run automatically every hour using our [BitBar Plugin](https://github.com/matryer/bitbar-plugins/pull/1460).

![BitBar](./img/bitbar.png)

1. [Install BitBar](https://github.com/matryer/bitbar/releases) on your Mac.
2. Set your plugin folder.
3. Create a new file in `mintable.1h.zsh` in your plugin folder.
4. Copy & paste [this](https://github.com/matryer/bitbar-plugins/blob/39e8f252ed69d0dd46bbe095299e52279e86d737/Finance/mintable.1h.zsh) into the file you just created and save.
5. Open **BitBar** > **Preferences** > **Refresh All** to update your spreadsheet.

> **Note:** The plugin above is pending approval and this install process should be much easier moving forward.

### Automatically – in your local machine's terminal – via `cron`

You can run Mintable automatically within your terminal using `cron`:

![`cron`](./img/cron.png)

```bash
echo "0 * * * * export PATH="/usr/local/bin:$PATH" && mintable fetch" > ~/mintable.cron
crontab ~/mintable.cron
```

The first step creates a new file `~/mintable.cron` which contains an interval and the command you want to run. The second step registers that file with `crontab`, the command-line executable which actually schedules the job with your operating system.

The default refresh interval is 1 hour – you can use [Crontab Guru](https://crontab.guru/) to define your own interval.

You can remove this schedule by running:

```bash
crontab -r
```

> **Note:** The instructions above assume your global `mintable` CLI lives in `/usr/local/bin`, but if your installation path is different (run `which mintable`) you should use that instead.

### Automatically – in the cloud – via GitHub Actions

You can use GitHub Actions to run Mintable automatically in the cloud:

![GitHub Actions](./img/github-actions.png)

1. Fork [this repo](https://github.com/kevinschaich/mintable).
2. Go to your repo's **Actions** > Click **I understand my workflows, go ahead and enable them**
3. Go to your repo's **Settings** > **Secrets** and add a **New Secret**.
4. Name the secret `MINTABLE_CONFIG`, and copy and paste the full contents of your `~/mintable.jsonc` file into the body of the secret.
5. In your repo's `./.github/workflows/fetch.yml`, uncomment the following block and commit the changes:

    ```
        # schedule:
        #   - cron:  '0 * * * *'
    ```

In the **Actions** tab of your repo, the **Fetch** workflow will now update your sheet periodically. The default refresh interval is 1 hour – you can use [Crontab Guru](https://crontab.guru/) to define your own interval.

> **Note:** The minimum interval supported by GitHub Actions is every 5 minutes.

---

## Transaction Rules

### Transaction `filter` Rules

Transaction `filter` rules allow you to exclude transactions from your spreadsheet based on a set of [conditions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions).

For example, if you wanted to exclude any cross-account transfers, you might add the following to your `transactions.rules` config:

```json
"rules": [
    {
        "conditions": [
            {
                "property": "name",
                "pattern": "(transfer|xfer|trnsfr)",
                "flags": "ig"
            }
        ],
        "type": "filter"
    }
]
```

### Transaction `override` Rules

Transaction `override` rules allow you to override auto-populated fields based on a set of [conditions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions), search for a [pattern](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions), and replace it with another [pattern](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions).

You might want to do this to standardize values between financial institutions (`XFER` -> `Transfer`), or tune things to suit your particular budgeting needs (described below).

For example, let's say you want to know how much you are spending on coffee each month, but your bank categorizes your favorite shops as `Restaurants – Fast Food`. You might add the following to your `transactions.rules` config:

```json
"rules": [
    {
        "conditions": [
            {
                "property": "name",
                "pattern": "(dunkin|starbucks|peets|philz)",
                "flags": "ig"
            }
        ],
        "type": "override",
        "property": "category",
        "findPattern": "Fast Food",
        "replacePattern": "Coffee Shops",
        "flags": "i"
    }
]
```

When you run `mintable fetch` the next time, the category would be `Restaurants – Coffee Shops`.

## Development

To get started:

```bash
git clone https://github.com/kevinschaich/mintable
cd mintable

npm install
npm run build
npm link
```

The global `mintable` command will now point to your local version (`/lib/scripts/cli.js`). To start compilation in watch mode:

```bash
npm run watch
```

To publish a new version, increment `version` in `package.json` and run:

```bash
git add package.json
git commit -m 'vX.X.X'
git push

rm -rf lib/
npm run build
npm publish
```

To revert to the production release of `mintable`, run:

```bash
npm unlink
npm install -g mintable
```

## Contributing

Before posting please check if your issue has already been reported. We'll gladly accept PRs, feature requests, or bugs via [Issues](https://github.com/kevinschaich/mintable/issues).
