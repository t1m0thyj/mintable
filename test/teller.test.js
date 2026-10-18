const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { TellerClient, TELLER_API_VERSION } = require('../lib/integrations/teller/tellerClient')
const { TellerIntegration } = require('../lib/integrations/teller/tellerIntegration')
const {
    normalizeTellerAccount,
    normalizeTellerTransaction,
    parseBankDate,
    parseMoney
} = require('../lib/integrations/teller/tellerNormalizer')

const accountFixture = require('./fixtures/teller-account.json')
const moneySigns = require('./fixtures/teller-money-signs.json')
const start = new Date(2026, 2, 1)
const end = new Date(2026, 2, 31)
const config = {
    id: 'teller',
    type: 'import',
    name: 'Teller',
    appId: 'fixture',
    pathCertificate: '',
    pathPrivateKey: '',
    environment: 'sandbox'
}

const makeRequest =
    (steps, captured = []) =>
    (url, options, callback) => {
        captured.push({ url: url.toString(), options })
        const request = new EventEmitter()
        let timeout
        request.setTimeout = (_milliseconds, handler) => (timeout = handler)
        request.write = () => {}
        request.destroy = error => queueMicrotask(() => request.emit('error', error))
        request.end = () =>
            queueMicrotask(() => {
                const step = steps.shift()
                if (!step) throw new Error('Unexpected request')
                if (step.network) {
                    const error = new Error('network failure')
                    error.code = step.network
                    request.emit('error', error)
                    return
                }
                if (step.timeout) return timeout()
                const response = new EventEmitter()
                response.statusCode = step.status ?? 200
                response.headers = step.headers || {}
                response.destroy = () => response.emit('aborted')
                callback(response)
                if (step.body !== undefined) response.emit('data', Buffer.from(step.body))
                response.emit('end')
            })
        return request
    }

const transaction = (id, date = '2026-03-01', amount = '-12.34') => ({
    id,
    account_id: 'account',
    date,
    amount,
    description: 'Fixture transaction',
    type: 'card_payment',
    status: 'posted'
})

const integration = requestJson => new TellerIntegration({ integrations: { teller: config } }, { requestJson })

test('client pins origin and API version and accepts empty 204 responses', async () => {
    const captured = []
    const client = new TellerClient(config, { request: makeRequest([{ status: 204 }, { status: 204 }], captured) })
    assert.equal(await client.requestJson('fixture-token', 'accounts/account', 'DELETE'), undefined)
    assert.equal(await client.requestJson('fixture-token', 'accounts/other', 'DELETE'), undefined)
    assert.equal(captured[0].url, 'https://api.teller.io/accounts/account')
    assert.equal(captured[0].options.headers['Teller-Version'], TELLER_API_VERSION)
    assert.equal(captured[0].options.auth, 'fixture-token:')
    assert.equal(captured[0].options.agent, captured[1].options.agent)
    await assert.rejects(client.requestJson('fixture-token', 'https://example.com/accounts'), { kind: 'request' })
    assert.equal(captured.length, 2)
})

test('client rejects missing and invalid certificates before requests', () => {
    assert.throws(() => new TellerClient({ ...config, environment: 'development' }), { kind: 'configuration' })
    assert.throws(
        () =>
            new TellerClient({
                ...config,
                environment: 'development',
                pathCertificate: path.join(__dirname, 'fixtures', 'transactions.csv'),
                pathPrivateKey: path.join(__dirname, 'fixtures', 'transactions.csv')
            }),
        { kind: 'configuration' }
    )
})

test('client retries only transient responses and honors bounded Retry-After', async () => {
    const delays = []
    const captured = []
    const client = new TellerClient(config, {
        request: makeRequest(
            [
                { status: 429, headers: { 'retry-after': '60' }, body: '{"error":{"code":"rate_limit"}}' },
                { status: 502, body: 'gateway unavailable' },
                { body: '{"ok":true}' }
            ],
            captured
        ),
        sleep: async delay => delays.push(delay)
    })
    assert.deepEqual(await client.requestJson('fixture', 'accounts'), { ok: true })
    assert.equal(captured.length, 3)
    assert.deepEqual(delays, [2000, 500])
})

test('client stops after timeout and network retry exhaustion', async () => {
    let attempts = 0
    const client = new TellerClient(config, {
        request: makeRequest([{ timeout: true }, { network: 'ECONNRESET' }, { timeout: true }], {
            push: () => attempts++
        }),
        sleep: async () => {}
    })
    await assert.rejects(client.requestJson('fixture', 'accounts'), { kind: 'timeout', retryable: true })
    assert.equal(attempts, 3)
})

test('client classifies credentials, disconnected enrollments, closed accounts, and missing resources', async () => {
    for (const [status, code, kind] of [
        [403, 'invalid_access_token', 'credentials'],
        [404, 'enrollment.disconnected.user_action.mfa_required', 'disconnected'],
        [410, 'account.closed', 'closed_account'],
        [404, 'not_found', 'unsupported_resource']
    ]) {
        const client = new TellerClient(config, {
            request: makeRequest([{ status, body: JSON.stringify({ error: { code, message: 'sensitive detail' } }) }]),
            sleep: async () => {}
        })
        await assert.rejects(client.requestJson('fixture', 'accounts'), error => {
            assert.equal(error.kind, kind)
            assert.equal(error.status, status)
            assert.equal(error.message.includes('sensitive detail'), false)
            return true
        })
    }
})

test('client rejects malformed JSON and empty successful bodies without retrying', async () => {
    for (const body of ['{', undefined]) {
        const captured = []
        const client = new TellerClient(config, {
            request: makeRequest([{ body }], captured),
            sleep: async () => {
                throw new Error('should not retry')
            }
        })
        await assert.rejects(client.requestJson('fixture', 'accounts'), { kind: 'malformed_response' })
        assert.equal(captured.length, 1)
    }
})

test('transaction pagination follows from_id, deduplicates IDs, and bounds dates', async () => {
    const routes = []
    const first = Array.from({ length: 100 }, (_, index) => transaction(`txn-${index}`))
    const second = [first[99], transaction('last', '2026-03-31'), transaction('outside', '2026-04-01')]
    const teller = integration(async (_token, route) => {
        routes.push(route)
        return routes.length === 1 ? first : second
    })
    const result = await teller.fetchPagedTransactions({ id: 'account', token: 'fixture' }, start, end)
    assert.equal(result.length, 101)
    assert.equal(new URL(`https://api.teller.io/${routes[0]}`).searchParams.get('start_date'), '2026-03-01')
    assert.equal(new URL(`https://api.teller.io/${routes[0]}`).searchParams.get('end_date'), '2026-03-31')
    assert.equal(new URL(`https://api.teller.io/${routes[1]}`).searchParams.get('from_id'), 'txn-99')
})

test('transaction pagination detects repeated cursors', async () => {
    const teller = integration(async () => Array.from({ length: 100 }, () => transaction('same')))
    await assert.rejects(teller.fetchPagedTransactions({ id: 'account', token: 'fixture' }, start, end), {
        kind: 'malformed_response'
    })
})

test('incremental request overlaps ten days', async () => {
    let route
    const teller = integration(async (_token, requestedRoute) => {
        route = requestedRoute
        return []
    })
    await teller.fetchPagedTransactions({ id: 'account', token: 'fixture' }, start, end, { incremental: true })
    assert.equal(new URL(`https://api.teller.io/${route}`).searchParams.get('start_date'), '2026-02-19')
})

test('normalizer preserves nullable balances, currency, pending state, category, counterparty, and bank date', () => {
    const account = normalizeTellerAccount(accountFixture, { ledger: '-5.25', available: null })
    assert.equal(account.current, -5.25)
    assert.equal(account.available, undefined)
    assert.equal(account.limit, undefined)
    assert.equal(account.currency, 'USD')
    const output = normalizeTellerTransaction(
        {
            ...transaction('pending', '2026-03-08', '-12.34'),
            status: 'pending',
            details: { category: null, counterparty: { name: 'Merchant', type: 'organization' } }
        },
        account,
        false
    )
    assert.equal(output.amount, 12.34)
    assert.equal(output.amountDecimal, '12.34')
    assert.equal(output.dateOnly, '2026-03-08')
    assert.equal(output.date.getFullYear(), 2026)
    assert.equal(output.date.getMonth(), 2)
    assert.equal(output.date.getDate(), 8)
    assert.equal(output.category, undefined)
    assert.equal(output.counterparty, 'Merchant')
    assert.equal(output.counterpartyType, 'organization')
    assert.equal(output.pending, true)
})

test('spending-positive mapping covers the sign scenarios in the fixture', () => {
    const account = normalizeTellerAccount(accountFixture, { ledger: '-10.00', available: '0.00' })
    assert.equal(account.current, -10)
    assert.equal(account.available, 0)
    for (const scenario of moneySigns) {
        const output = normalizeTellerTransaction(
            transaction(scenario.scenario, '2026-03-01', scenario.amount),
            account,
            scenario.accountType === 'credit'
        )
        assert.equal(output.amount, scenario.expected, scenario.scenario)
        assert.equal(Number(output.amountDecimal), scenario.expected, scenario.scenario)
    }
})

test('normalizer rejects invalid money and calendar dates', () => {
    for (const value of ['NaN', '1e3', '12.3.4', 'Infinity', 12, '9007199254740992']) {
        assert.throws(() => parseMoney(value, 'test amount'), { kind: 'malformed_response' })
    }
    assert.throws(() => parseBankDate('2026-02-30'), { kind: 'malformed_response' })
})

test('account fetch skips unavailable balances and rejects unavailable transactions', async () => {
    let routes = []
    const teller = integration(async (_token, route) => {
        routes.push(route)
        return route.includes('/transactions?') ? [] : { ...accountFixture, links: { transactions: '/transactions' } }
    })
    const [account] = await teller.fetchAccount({ id: 'account', token: 'fixture' }, start, end)
    assert.equal(account.current, undefined)
    assert.equal(
        routes.some(route => route.endsWith('/balances')),
        false
    )
    const unsupported = integration(async () => ({ ...accountFixture, links: { balances: '/balances' } }))
    await assert.rejects(unsupported.fetchAccount({ id: 'account', token: 'fixture' }, start, end), {
        kind: 'unsupported_resource'
    })
})

test('malformed account and transaction payloads reject without hanging', async () => {
    const malformedAccount = integration(async () => ({ id: 'account', type: 'depository' }))
    await assert.rejects(malformedAccount.fetchAccount({ id: 'account', token: 'fixture' }, start, end), {
        kind: 'malformed_response'
    })
    const malformedTransactions = integration(async () => ({ transactions: [] }))
    await assert.rejects(
        malformedTransactions.fetchPagedTransactions({ id: 'account', token: 'fixture' }, start, end),
        { kind: 'malformed_response' }
    )
    const failedRequest = integration(async () => {
        throw new Error('fixture request failed')
    })
    await assert.rejects(failedRequest.fetchPagedTransactions({ id: 'account', token: 'fixture' }, start, end), {
        message: 'fixture request failed'
    })
})
