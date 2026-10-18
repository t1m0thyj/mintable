const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { startTellerSetupServer } = require('../lib/integrations/teller/setupServer')
const { runTellerAccountSetup } = require('../lib/integrations/teller/accountSetup')

const makeConfig = () => ({
    version: 3,
    integrations: {
        teller: {
            id: 'teller',
            name: 'Teller',
            type: 'import',
            appId: 'app_test',
            environment: 'sandbox',
            pathCertificate: '',
            pathPrivateKey: ''
        }
    },
    enrollments: {},
    accounts: {},
    transactions: { integration: 'csv-export', properties: ['date'] },
    balances: { integration: 'csv-export', properties: ['account'] }
})
const account = (id, enrollmentId) => ({
    id,
    enrollment_id: enrollmentId,
    name: `<${id}>`,
    type: 'depository',
    currency: 'USD',
    institution: { name: 'Test Bank' },
    links: { balances: '/balances', transactions: '/transactions' }
})
const start = (config, overrides = {}) =>
    startTellerSetupServer(config, {
        client: {
            requestJson: async (_token, route) => {
                assert.equal(route, 'accounts')
                return [account('acc_one', 'enr_one'), account('acc_two', 'enr_one')]
            }
        },
        save: change => change(config),
        ...overrides
    })
const requestFor = session => {
    const url = new URL(session.url)
    const credential = url.hash.slice(1)
    url.hash = ''
    const post = async (route, body = {}, headers = {}) => {
        const response = await fetch(new URL(route, url), {
            method: 'POST',
            headers: {
                Origin: url.origin,
                'Content-Type': 'application/json',
                'X-Mintable-Session': credential,
                ...headers
            },
            body: JSON.stringify(body)
        })
        const text = await response.text()
        return { status: response.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text }
    }
    return { url, credential, post }
}

test('setup links multiple accounts with one token, repairs, removes locally, and completes only on Done', async () => {
    const config = makeConfig()
    const session = await start(config)
    const { post } = requestFor(session)
    try {
        const setup = await post('/setup')
        assert.equal(setup.body.environment, 'sandbox')
        assert.equal(setup.body.applicationId, 'app_test')
        assert.equal((await post('/accounts')).body.length, 0)
        assert.equal((await post('/register', { accountId: 'acc_one' })).status, 400)
        const enrollment = {
            enrollment: { id: 'enr_one', institution: { name: 'Test Bank' } },
            accessToken: 'test_token_first'
        }
        const response = await post('/enrollment', enrollment)
        assert.equal(response.status, 200)
        assert.equal(response.body.length, 2)
        assert.doesNotMatch(JSON.stringify(response.body), /token_/)
        assert.equal((await post('/register', { accountId: 'acc_other' })).status, 400)
        assert.equal((await post('/register', { accountId: 'acc_one' })).status, 200)
        assert.equal((await post('/register', { accountId: 'acc_two' })).status, 200)
        assert.equal(Object.keys(config.enrollments).length, 1)
        assert.equal(config.enrollments.enr_one.token, 'test_token_first')
        assert.equal(config.accounts.acc_two.enrollmentId, 'enr_one')
        const saved = await post('/accounts')
        assert.equal(saved.body.length, 2)
        assert.doesNotMatch(JSON.stringify(saved.body), /token_/)
        assert.equal((await post('/enrollment', { ...enrollment, accessToken: 'token_repaired' })).status, 200)
        assert.equal(config.enrollments.enr_one.token, 'token_repaired')
        assert.equal((await post('/remove', { accountId: 'acc_one' })).status, 200)
        assert.ok(config.enrollments.enr_one)
        assert.equal((await post('/remove', { accountId: 'acc_two' })).status, 200)
        assert.equal(config.enrollments.enr_one, undefined)
        assert.equal((await post('/done')).status, 200)
        await session.done
    } finally {
        await session.close()
    }
})

test('setup rejects forged requests and accounts outside the active enrollment', async () => {
    const config = makeConfig()
    const session = await start(config, { client: { requestJson: async () => [account('acc_one', 'enr_elsewhere')] } })
    const { url, post } = requestFor(session)
    try {
        assert.equal((await post('/setup', {}, { 'X-Mintable-Session': 'wrong' })).status, 403)
        assert.equal((await post('/setup', {}, { Origin: 'http://evil.example' })).status, 403)
        const badHost = await new Promise(resolve => {
            const request = http.request(url, { method: 'GET', headers: { Host: 'evil.example' } }, response => {
                response.resume()
                response.on('end', () => resolve(response.statusCode))
            })
            request.end()
        })
        assert.equal(badHost, 403)
        assert.equal(
            (await post('/enrollment', { enrollment: { id: 'enr_one' }, accessToken: 'token_one' })).status,
            400
        )
        assert.equal((await post('/accounts')).status, 200)
        assert.equal(Object.keys(config.enrollments).length, 0)
        assert.equal((await fetch(url).then(response => response.text())).includes('token_one'), false)
    } finally {
        await session.close()
    }
    await assert.rejects(session.done, /cancelled/)
})

test('setup cancellation, occupied port, and browser launch failure shut down the server', async () => {
    const config = makeConfig()
    const session = await start(config)
    const { url, post } = requestFor(session)
    await assert.rejects(start(config, { port: Number(url.port) }), /EADDRINUSE/)
    assert.equal((await post('/cancel')).status, 200)
    await assert.rejects(session.done, /cancelled/)
    await assert.rejects(fetch(url), /fetch failed/)
    let launchedUrl
    await assert.rejects(
        runTellerAccountSetup(
            config,
            {
                client: { requestJson: async () => [] },
                save: change => change(config)
            },
            async address => {
                launchedUrl = address
                throw new Error('browser unavailable')
            }
        ),
        /browser unavailable/
    )
    await assert.rejects(fetch(new URL(launchedUrl)), /fetch failed/)
})
