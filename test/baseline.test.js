const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parse } = require('csv-parse/sync')
const { IntegrationId } = require('../lib/types/integrations')
const { TellerIntegration } = require('../lib/integrations/teller/tellerIntegration')
const { CSVImportIntegration } = require('../lib/integrations/csv-import/csvImportIntegration')
const { CSVExportIntegration } = require('../lib/integrations/csv-export/csvExportIntegration')
const { applyTransactionRules } = require('../lib/common/transactionRules')
const { getConfigSchema, parseConfig, validateConfig } = require('../lib/common/config')

const tellerTransactions = require('./fixtures/teller-transactions.json')
const marchStart = new Date(2026, 2, 1)
const marchEnd = new Date(2026, 2, 31)

test('Teller date filter includes both month boundaries', async () => {
    const teller = new TellerIntegration({ integrations: { teller: {} } })
    teller.tellerApi = async () => tellerTransactions
    const result = await teller.fetchPagedTransactions({ id: 'checking', token: 'fixture' }, marchStart, marchEnd)
    assert.deepEqual(
        result.map(transaction => transaction.id),
        ['first', 'last']
    )
})

test('existing Teller sign convention keeps spending positive for both account types', async () => {
    for (const [accountType, amount, expected] of [
        ['depository', '-12.34', 12.34],
        ['depository', '25.00', -25],
        ['credit', '12.34', 12.34],
        ['credit', '-25.00', -25],
        ['credit', '0.00', 0]
    ]) {
        const teller = new TellerIntegration({ integrations: { teller: {} } })
        teller.tellerApi = async (_token, endpoint) => {
            if (endpoint.endsWith('/balances')) return { ledger: '0.00', available: '0.00' }
            return { name: 'Fixture', type: accountType, currency: 'USD', institution: { name: 'Bank' } }
        }
        teller.fetchPagedTransactions = async () => [
            {
                id: 'item',
                account_id: 'account',
                date: '2026-03-01',
                amount,
                description: 'Fixture',
                type: 'card_payment',
                status: 'posted'
            }
        ]
        const [account] = await teller.fetchAccount({ id: 'account', token: 'fixture' }, marchStart, marchEnd)
        assert.equal(account.transactions[0].amount, expected)
    }
})

test('transaction rules filter then override matching records', () => {
    const account = {
        account: 'Checking',
        integration: IntegrationId.CSVImport,
        transactions: [
            { name: 'Ignore this', category: 'Other', amount: 1 },
            { name: 'Market purchase', category: 'Other', amount: 12 },
            { name: 'Cafe', category: 'Other', amount: 5 }
        ]
    }
    const { accounts, countOverridden } = applyTransactionRules(
        [account],
        [
            { type: 'filter', conditions: [{ property: 'name', pattern: '^Ignore' }] },
            {
                type: 'override',
                conditions: [{ property: 'name', pattern: 'Market' }],
                property: 'category',
                findPattern: 'Other',
                replacePattern: 'Groceries',
                flags: ''
            }
        ]
    )
    assert.deepEqual(
        accounts[0].transactions.map(transaction => [transaction.name, transaction.category]),
        [
            ['Market purchase', 'Groceries'],
            ['Cafe', 'Other']
        ]
    )
    assert.equal(countOverridden, 1)
})

test('CSV import parses quoted currency and respects date boundaries', async () => {
    const csv = new CSVImportIntegration({ integrations: { 'csv-import': {} } })
    const account = await csv.fetchAccount(
        {
            id: 'Checking',
            integration: IntegrationId.CSVImport,
            paths: [path.join(__dirname, 'fixtures', 'transactions.csv')],
            transformer: { Date: 'date', Amount: 'amount', Description: 'name' },
            dateFormat: 'MM/dd/yyyy'
        },
        marchStart,
        marchEnd
    )
    assert.deepEqual(
        account.transactions.map(transaction => [transaction.name, transaction.amount]),
        [
            ['Purchase', -12.34],
            ['Deposit', 25]
        ]
    )
})

test('CSV export uses configured column order and date format', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mintable-test-'))
    try {
        const transactionPath = path.join(directory, 'transactions.csv')
        const balancePath = path.join(directory, 'balances.csv')
        const exporter = new CSVExportIntegration({
            integrations: { 'csv-export': { transactionPath, balancePath, dateFormat: 'yyyy-MM-dd' } },
            transactions: { properties: ['date', 'amount', 'name'] },
            balances: { properties: ['account', 'current'] }
        })
        await exporter.updateTransactions([
            {
                account: 'Checking',
                current: 50,
                transactions: [{ date: marchStart, amount: 12.34, name: 'Purchase' }]
            }
        ])
        await exporter.updateBalances([{ account: 'Checking', current: 50 }])
        assert.deepEqual(parse(fs.readFileSync(transactionPath), { columns: true }), [
            { date: '2026-03-01', amount: '12.34', name: 'Purchase' }
        ])
        assert.deepEqual(parse(fs.readFileSync(balancePath), { columns: true }), [
            { account: 'Checking', current: '50' }
        ])
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('packaged schema validates JSONC configuration', () => {
    const parsed = parseConfig(`{
        // Comments are supported in user config.
        "accounts": {},
        "integrations": {},
        "transactions": { "integration": "google", "properties": ["date"] },
        "balances": { "integration": "google", "properties": ["account"] }
    }`)
    assert.equal(getConfigSchema().type, 'object')
    assert.deepEqual(validateConfig(parsed), parsed)
})
