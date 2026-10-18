const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { MintableError, logError } = require('../lib/common/logging')
const { resolveConfigRelativePath, resolveHomePath, validateConfig } = require('../lib/common/config')

const executable = path.join(__dirname, '..', 'lib', 'scripts', 'cli.js')
const basicConfig = () => ({
    version: 3,
    integrations: {},
    enrollments: {},
    accounts: {},
    transactions: { integration: 'csv-export', properties: ['date', 'amount', 'name'] },
    balances: { integration: 'csv-export', properties: ['account', 'current'] }
})

test('logging throws a typed error without exiting the process', () => {
    assert.throws(
        () => logError('Expected failure', { token: 'private' }),
        error => {
            assert.ok(error instanceof MintableError)
            assert.equal(error.code, 'operation')
            assert.equal(error.message, 'Expected failure')
            return true
        }
    )
})

test('relative certificate paths resolve beside config and tilde uses home', () => {
    const source = { type: 'file', path: path.join(os.tmpdir(), 'mintable-config', 'settings.jsonc') }
    assert.equal(
        resolveConfigRelativePath('certs/client.pem', source),
        path.join(os.tmpdir(), 'mintable-config', 'certs', 'client.pem')
    )
    assert.equal(resolveConfigRelativePath('~/client.pem', source), path.join(os.homedir(), 'client.pem'))
    assert.equal(resolveHomePath('./settings.jsonc'), path.resolve('./settings.jsonc'))
    if (process.platform === 'win32') {
        assert.equal(resolveConfigRelativePath('C:\\keys\\client.pem', source), 'C:\\keys\\client.pem')
    }
})

test('invalid transaction rule expressions fail during configuration validation', () => {
    const config = basicConfig()
    config.transactions.rules = [{ type: 'filter', conditions: [{ property: 'name', pattern: '[', flags: 'i' }] }]
    assert.throws(() => validateConfig(config), /invalid regular expression/)
})

test('--config-variable reads a named variable and conflicting sources fail explicitly', () => {
    const env = { ...process.env, MINTABLE_TEST_CONFIG: JSON.stringify(basicConfig()) }
    const read = spawnSync(process.execPath, [executable, 'fetch', '--config-variable', 'MINTABLE_TEST_CONFIG'], {
        env,
        encoding: 'utf8'
    })
    assert.equal(read.status, 1)
    assert.match(read.stdout, /MINTABLE_TEST_CONFIG/)
    assert.match(read.stderr, /No accounts are configured/)
    const conflict = spawnSync(
        process.execPath,
        [executable, 'fetch', '--config-variable', 'MINTABLE_TEST_CONFIG', '--config-file', 'other.jsonc'],
        { env, encoding: 'utf8' }
    )
    assert.equal(conflict.status, 1)
    assert.match(conflict.stderr, /either --config-file or --config-variable/)
})

test('invalid calendar dates stop fetch before account retrieval', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mintable-dates-'))
    try {
        const config = basicConfig()
        config.transactions.startDate = '2026-02-30'
        const configPath = path.join(directory, 'config.jsonc')
        fs.writeFileSync(configPath, JSON.stringify(config))
        const result = spawnSync(process.execPath, [executable, 'fetch', '--config-file', configPath], {
            encoding: 'utf8'
        })
        assert.equal(result.status, 1)
        assert.match(result.stderr, /valid calendar date/)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
