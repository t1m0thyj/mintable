<h4 align="center"><img width="100" src="./docs/img/icon.png" alt="Mintable"></h4>
<h1 align="center" style="font-weight: 500; font-size: 60px !important; border-bottom: 0 !important;">Mintable</h1>

<h4 align="center">Automate your personal finances – for free, with no ads, and no data collection.</h4>

<br>

Mintable helps you:

- Keep track of your account balances
- Aggregate transactions from all your banking institutions, including checking accounts, savings accounts, and credit cards
- Analyze and budget your spending using a spreadsheet and formulas

![](./docs/img/mintable.png)

<br>

[![](https://img.shields.io/github/actions/workflow/status/kevinschaich/mintable/test.yml?branch=master)](https://github.com/kevinschaich/mintable/actions?query=workflow%3ATest)
[![](https://img.shields.io/npm/v/mintable)](https://www.npmjs.com/package/mintable)
[![](https://img.shields.io/github/release/kevinschaich/mintable.svg)](https://github.com/kevinschaich/mintable/releases)
[![](https://img.shields.io/github/license/kevinschaich/mintable.svg)](https://github.com/kevinschaich/mintable/blob/master/LICENSE)
[![](https://img.shields.io/github/issues/kevinschaich/mintable.svg)](https://github.com/kevinschaich/mintable/issues)
[![](https://img.shields.io/github/issues-pr/kevinschaich/mintable.svg)](https://github.com/kevinschaich/mintable/pulls)
[![](https://img.shields.io/reddit/subreddit-subscribers/Mintable?style=social)](https://reddit.com/r/Mintable)

---

## Quickstart

Requires Node 24 or newer.

1. Create a Teller application if you want to connect banks, or prepare CSV files for CSV-only use.
2. Install Mintable and run the wizard:

    ```bash
    npm install -g mintable
    mintable setup
    ```

3. Update balances and transactions with `mintable fetch`.

Teller development and production use real bank data; sandbox uses test data. The wizard lets you choose Google Sheets or CSV output. See the [setup guide](./docs/README.md) for linking, repair, and CSV options.

## Documentation

Check out the full documentation [in the `./docs` folder](./docs/README.md).

## FAQs

**WTF is 'Mintable'?!**

> **min·ta·ble**: _noun._
> 1. An open-source tool to automate your personal finances – for free, with no ads, and no data collection. Derived from *mint* (the [wildly popular personal finance app from Intuit](https://www.mint.com/)) + *table* (a spreadsheet).

**Do I have to connect a bank?**

* No. Choose CSV-only import in `mintable setup`.

**Do I have to use Google Sheets?**

* Nope. You can [export your account balances & transactions to a CSV file](./docs/README.md#on-your-local-machine--via-csv-files) exclusively on your local machine.

**Do I have to manually run this every time I want new transactions in my spreadsheet?**

* Nope. You can automate it for free using [BitBar](./docs/README.md#automatically-in-your-macs-menu-bar--via-bitbar), [`cron`](./docs/README.md#automatically-in-your-local-machines-terminal--via-cron), or [GitHub Actions](./docs/README.md#automatically-in-the-cloud--via-github-actions).

**How do I use it on Windows?**

* Use Node 24 or newer. The setup wizard accepts absolute Windows paths for CSV files.

**It's not working!**

- [File an issue](https://github.com/kevinschaich/mintable/issues)

## Alternatives

- [**Money in Excel**](https://www.microsoft.com/en-us/microsoft-365/blog/2020/06/15/introducing-money-excel-easier-manage-finances/): Recently announced partnership between Microsoft/Plaid. Requires a Microsoft 365 subscription ($70+/year).
- [**Mint**](https://www.mint.com/): Owned by Intuit (TurboTax). Apps for iOS/Android/Web.
- [**build-your-own-mint**](https://github.com/yyx990803/build-your-own-mint): Some assembly required. More flexible.
