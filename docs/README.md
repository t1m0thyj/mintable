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

Plaid is no longer a live provider. Existing Plaid credentials cannot be reused as Teller credentials. The v3 migration flow for old configurations is still in progress; keep old configs and exports until that work is complete.

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
