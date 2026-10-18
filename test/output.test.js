const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parse } = require('csv-parse/sync')
const { GoogleIntegration, mergeGoogleCredentials } = require('../lib/integrations/google/googleIntegration')
const { authorizeDesktop } = require('../lib/integrations/google/setup')
const { columnLetter, planKeyedSheet, KEY_COLUMN } = require('../lib/integrations/google/sheetPlan')
const { CSVExportIntegration } = require('../lib/integrations/csv-export/csvExportIntegration')

const config = () => ({
    version: 3,
    integrations: {
        google: {
            id: 'google',
            documentId: 'sheet-id',
            credentials: {
                clientId: 'client-id',
                clientSecret: 'secret',
                scope: ['https://www.googleapis.com/auth/spreadsheets'],
                refreshToken: 'refresh'
            }
        }
    },
    transactions: { integration: 'google', properties: ['date', 'amount', 'name'] },
    balances: { integration: 'google', properties: ['account', 'current'] }
})

function fixtureSheets() {
    const byTitle = new Map()
    const calls = []
    return {
        byTitle,
        calls,
        get: async () => ({
            data: {
                sheets: [...byTitle.values()].map(sheet => ({
                    properties: {
                        title: sheet.title,
                        sheetId: sheet.id,
                        gridProperties: { rowCount: sheet.gridRows, columnCount: sheet.gridColumns }
                    }
                }))
            }
        }),
        values: {
            get: async ({ range }) => {
                const title = range.slice(1, -1).replaceAll("''", "'")
                return { data: { values: byTitle.get(title).rows.map(row => [...row]) } }
            }
        },
        batchUpdate: async ({ requestBody }) => {
            calls.push(requestBody.requests)
            for (const request of requestBody.requests) {
                if (request.addSheet) {
                    const { title, sheetId, gridProperties } = request.addSheet.properties
                    byTitle.set(title, {
                        title,
                        id: sheetId,
                        rows: [],
                        gridRows: gridProperties.rowCount,
                        gridColumns: gridProperties.columnCount
                    })
                } else if (request.appendDimension) {
                    const sheet = [...byTitle.values()].find(sheet => sheet.id === request.appendDimension.sheetId)
                    if (request.appendDimension.dimension === 'ROWS') sheet.gridRows += request.appendDimension.length
                    else sheet.gridColumns += request.appendDimension.length
                } else if (request.updateCells) {
                    const update = request.updateCells
                    const sheet = [...byTitle.values()].find(sheet => sheet.id === update.range.sheetId)
                    const index = update.range.startRowIndex
                    const prior = sheet.rows[index] || []
                    const values = update.rows[0].values.map(cell => {
                        const entered = cell.userEnteredValue
                        return entered?.stringValue ?? entered?.numberValue ?? entered?.boolValue ?? ''
                    })
                    sheet.rows[index] = [...values, ...prior.slice(values.length)]
                }
            }
            return { data: {} }
        }
    }
}

function account(transactions) {
    return [
        {
            integration: 'csv-import',
            accountId: 'account-1',
            account: 'Checking',
            current: 100,
            transactions: transactions.map(([id, date, name]) => ({
                integration: 'csv-import',
                accountId: 'account-1',
                transactionId: id,
                date: new Date(`${date}T12:00:00`),
                dateOnly: date,
                amount: 12.5,
                name
            }))
        }
    ]
}

test('Google keyed rows survive repeat fetches, reordering, shrink, and zero-result months', async () => {
    const sheets = fixtureSheets()
    const google = new GoogleIntegration(config(), sheets, false)
    const start = new Date('2026-03-01T00:00:00')
    const end = new Date('2026-03-31T12:00:00')
    await google.updateAll(
        account([
            ['a', '2026-03-01', '=literal'],
            ['b', '2026-03-02', 'Coffee']
        ]),
        start,
        end
    )
    const march = sheets.byTitle.get('2026.03')
    assert.equal(march.rows[1][2], '=literal')
    const literalCell = sheets.calls[0]
        .filter(request => request.updateCells?.range.sheetId === march.id)
        .find(request => request.updateCells?.range.startRowIndex === 1).updateCells.rows[0].values[2]
    assert.deepEqual(literalCell.userEnteredValue, { stringValue: '=literal' })
    assert.equal(sheets.calls.length, 1)
    march.rows[1][4] = '=A2&" note"'
    march.rows[2][4] = 'reviewed'
    await google.updateAll(
        account([
            ['b', '2026-03-02', 'Coffee'],
            ['a', '2026-03-01', '=literal']
        ]),
        start,
        end
    )
    assert.equal(march.rows[1][4], '=A2&" note"')
    assert.equal(march.rows[2][4], 'reviewed')
    assert.equal(march.rows.length, 3)
    await google.updateAll(account([['a', '2026-03-01', '=literal']]), start, end)
    assert.equal(march.rows[2][0], '')
    assert.match(march.rows[2][3], /^retired:/)
    assert.equal(march.rows[2][4], 'reviewed')
    await google.updateAll(account([]), start, end)
    assert.equal(march.rows[1][0], '')
    assert.equal(march.rows[1][4], '=A2&" note"')
    assert.equal(march.rows.length, 3)
    await google.updateAll(account([['a', '2026-03-01', '=literal']]), start, end)
    assert.equal(march.rows[1][2], '=literal')
    assert.equal(march.rows[1][4], '=A2&" note"')
    assert.equal(march.rows.length, 3)
})

test('stale balance rows clear only managed cells and preserve annotations', async () => {
    const sheets = fixtureSheets()
    const google = new GoogleIntegration(config(), sheets, false)
    const first = { integration: 'teller', accountId: 'one', account: 'One', current: 10, transactions: [] }
    const second = { integration: 'teller', accountId: 'two', account: 'Two', current: 20, transactions: [] }
    await google.updateBalances([first, second])
    const balances = sheets.byTitle.get('Balances')
    balances.rows[2][3] = '=B3*2'
    await google.updateBalances([first])
    assert.equal(balances.rows[2][0], '')
    assert.match(balances.rows[2][2], /^retired:/)
    assert.equal(balances.rows[2][3], '=B3*2')
})

test('month tab and transaction date formats are independent', async () => {
    const settings = config()
    settings.integrations.google.monthTabFormat = 'MMM yyyy'
    settings.integrations.google.transactionDateFormat = 'MM/dd/yyyy'
    const sheets = fixtureSheets()
    const google = new GoogleIntegration(settings, sheets, false)
    await google.updateTransactions(account([['a', '2026-03-01', 'A']]), new Date('2026-03-01'), new Date('2026-03-31'))
    assert.equal(sheets.byTitle.get('Mar 2026').rows[1][0], '03/01/2026')
})

test('older Teller history merges instead of retiring rows from a limited provider window', async () => {
    const sheets = fixtureSheets()
    const google = new GoogleIntegration(config(), sheets, false)
    const old = account([['a', '2026-03-01', 'A']])
    old[0].integration = 'teller'
    old[0].transactions[0].integration = 'teller'
    await google.updateTransactions(old, new Date('2026-03-01'), new Date('2026-03-31'))
    await google.updateTransactions([{ ...old[0], transactions: [] }], new Date('2026-03-01'), new Date('2026-03-31'))
    assert.equal(sheets.byTitle.get('2026.03').rows[1][2], 'A')
})

test('history from an account no longer configured is kept', async () => {
    const sheets = fixtureSheets()
    const google = new GoogleIntegration(config(), sheets, false)
    const first = account([['a', '2026-03-01', 'A']])[0]
    const second = account([['b', '2026-03-02', 'B']])[0]
    second.accountId = 'account-2'
    second.transactions[0].accountId = 'account-2'
    const start = new Date('2026-03-01T00:00:00')
    const end = new Date('2026-03-31T12:00:00')
    await google.updateTransactions([first, second], start, end)
    await google.updateTransactions([{ ...first, transactions: [] }], start, end)
    const rows = sheets.byTitle.get('2026.03').rows
    assert.equal(rows[1][0], '')
    assert.equal(rows[2][2], 'B')
})

test('partial month keeps missing history and failed batch leaves all prior rows intact', async () => {
    const sheets = fixtureSheets()
    const google = new GoogleIntegration(config(), sheets, false)
    await google.updateAll(
        account([
            ['a', '2026-03-01', 'A'],
            ['b', '2026-03-02', 'B']
        ]),
        new Date('2026-03-01'),
        new Date('2026-03-31')
    )
    const march = sheets.byTitle.get('2026.03')
    await google.updateAll(account([['b', '2026-03-02', 'B']]), new Date('2026-03-02'), new Date('2026-03-03'))
    assert.equal(march.rows[1][2], 'A')
    const before = JSON.stringify(march.rows)
    sheets.batchUpdate = async () => {
        throw new Error('server failed')
    }
    await assert.rejects(
        google.updateAll(account([]), new Date('2026-03-01'), new Date('2026-03-31')),
        /Google Sheets request failed/
    )
    assert.equal(JSON.stringify(march.rows), before)
})

test('legacy unkeyed layout is rejected before any write; columns extend beyond Z', async () => {
    const sheets = fixtureSheets()
    sheets.byTitle.set('2026.03', {
        title: '2026.03',
        id: 5,
        gridRows: 1000,
        gridColumns: 26,
        rows: [
            ['date', 'amount', 'name'],
            ['2026-03-01', 12.5, 'Old']
        ]
    })
    const google = new GoogleIntegration(config(), sheets, false)
    await assert.rejects(
        google.updateAll(
            account([['a', '2026-03-01', 'A']]),
            new Date('2026-03-01'),
            new Date('2026-03-31'),
            false,
            true
        ),
        /older or different column layout/
    )
    assert.equal(sheets.calls.length, 0)
    assert.equal(columnLetter(0), 'A')
    assert.equal(columnLetter(25), 'Z')
    assert.equal(columnLetter(26), 'AA')
    assert.equal(columnLetter(702), 'AAA')
    const columns = Array.from({ length: 30 }, (_, i) => `c${i}`)
    const requests = planKeyedSheet('Wide', 7, 1000, [], columns, [{ key: 'one', values: columns }], true)
    assert.equal(requests[0].updateCells.range.endColumnIndex, 31)
    assert.equal(KEY_COLUMN, '_mintable_key')
})

test('Google refresh tokens survive access-only refresh and revoked authorization is actionable', async () => {
    assert.deepEqual(
        mergeGoogleCredentials(
            { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1', refreshToken: 'keep' },
            { access_token: 'new' }
        ).refreshToken,
        'keep'
    )
    const sheets = fixtureSheets()
    sheets.get = async () => {
        throw new Error('invalid_grant')
    }
    const google = new GoogleIntegration(config(), sheets, false)
    await assert.rejects(google.updateBalances(account([])), /google-setup/)
})

test('desktop OAuth validates state and exchanges the code with PKCE', async () => {
    const observed = {}
    const fake = {
        client: { generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier', codeChallenge: 'challenge' }) },
        authorizationUrl: (redirect, state, challenge) => {
            Object.assign(observed, { redirect, state, challenge })
            return `https://accounts.google.test/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${state}&code_challenge=${challenge}`
        },
        getAccessTokens: async (code, verifier, redirect) => {
            Object.assign(observed, { code, verifier, exchangeRedirect: redirect })
            return { access_token: 'access', refresh_token: 'refresh' }
        }
    }
    const tokens = await authorizeDesktop(fake, async url => {
        const auth = new URL(url)
        const callback = new URL(auth.searchParams.get('redirect_uri'))
        callback.searchParams.set('state', auth.searchParams.get('state'))
        callback.searchParams.set('code', 'code')
        assert.equal((await fetch(callback)).status, 200)
    })
    assert.equal(tokens.refresh_token, 'refresh')
    assert.deepEqual(
        [observed.challenge, observed.verifier, observed.code, observed.exchangeRedirect],
        ['challenge', 'verifier', 'code', observed.redirect]
    )
    await assert.rejects(
        authorizeDesktop(fake, async url => {
            const callback = new URL(new URL(url).searchParams.get('redirect_uri'))
            callback.searchParams.set('state', 'wrong')
            callback.searchParams.set('code', 'code')
            assert.equal((await fetch(callback)).status, 400)
        }),
        /state did not match/
    )
})

test('CSV export writes full dates atomically and keeps dangerous text literal', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mintable-output-'))
    try {
        const transactionPath = path.join(directory, 'transactions.csv')
        const balancePath = path.join(directory, 'balances.csv')
        const exporter = new CSVExportIntegration({
            integrations: { 'csv-export': { transactionPath, balancePath } },
            transactions: { properties: ['date', 'amount', 'name'] },
            balances: { properties: ['account', 'current'] }
        })
        await exporter.updateTransactions([
            { transactions: [{ date: new Date('2026-03-04T12:00:00'), amount: -12.5, name: '=IMPORTXML("x")' }] }
        ])
        await exporter.updateBalances([{ account: '@Checking', current: -12.5 }])
        assert.deepEqual(parse(fs.readFileSync(transactionPath), { columns: true }), [
            { date: '2026-03-04', amount: '-12.5', name: '\'=IMPORTXML("x")' }
        ])
        assert.deepEqual(parse(fs.readFileSync(balancePath), { columns: true }), [
            { account: "'@Checking", current: '-12.5' }
        ])
        assert.deepEqual(fs.readdirSync(directory).sort(), ['balances.csv', 'transactions.csv'])
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('a failed second account stops fetch before either CSV output changes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mintable-incomplete-'))
    try {
        const transactionPath = path.join(directory, 'transactions.csv')
        const balancePath = path.join(directory, 'balances.csv')
        const configPath = path.join(directory, 'config.jsonc')
        fs.writeFileSync(transactionPath, 'original transactions')
        fs.writeFileSync(balancePath, 'original balances')
        const makeAccount = (id, source) => ({
            id,
            integration: 'csv-import',
            paths: [source],
            transformer: { Date: 'date', Amount: 'amount', Description: 'name' },
            dateFormat: 'MM/dd/yyyy'
        })
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                version: 3,
                accounts: {
                    first: makeAccount('First', path.join(__dirname, 'fixtures', 'transactions.csv')),
                    second: makeAccount('Second', path.join(directory, 'missing.csv'))
                },
                enrollments: {},
                integrations: {
                    'csv-import': { id: 'csv-import', name: 'CSV import', type: 'import' },
                    'csv-export': {
                        id: 'csv-export',
                        name: 'CSV export',
                        type: 'export',
                        transactionPath,
                        balancePath,
                        dateFormat: 'yyyy-MM-dd'
                    }
                },
                transactions: {
                    integration: 'csv-export',
                    properties: ['date', 'amount', 'name'],
                    startDate: '2026-03-01',
                    endDate: '2026-03-31'
                },
                balances: { integration: 'csv-export', properties: ['account', 'current'] }
            })
        )
        const result = spawnSync(
            process.execPath,
            [path.join(__dirname, '..', 'lib', 'scripts', 'cli.js'), 'fetch', '--config-file', configPath],
            { encoding: 'utf8', timeout: 15000 }
        )
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /No files resolved/)
        assert.equal(fs.readFileSync(transactionPath, 'utf8'), 'original transactions')
        assert.equal(fs.readFileSync(balancePath, 'utf8'), 'original balances')
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
