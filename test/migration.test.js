const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parse } = require('csv-parse/sync')
const { previewMigration, applyMigration, previewActivation, applyActivation } = require('../lib/scripts/migrate')
const { previewReconciliation, applyReconciliation } = require('../lib/scripts/reconcile')

function inTemp(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mintable-migrate-'))
    try {
        return run(directory)
    } finally {
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(directory, { recursive: true, force: true })
    }
}
const write = (directory, name, contents) => {
    const target = path.join(directory, name)
    fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2))
    return target
}
const v2 = directory => {
    const transactions = write(directory, 'history.csv', 'date,amount,name,account\n2026-03-01,12,Coffee,Checking\n')
    const balances = write(directory, 'balances.csv', 'account,current\nChecking,100\n')
    return {
        integrations: {
            plaid: {
                id: 'plaid',
                name: 'Plaid',
                type: 'import',
                credentials: { clientId: 'secret-client', secret: 'secret-bank' }
            },
            google: {
                id: 'google',
                name: 'Sheets',
                type: 'export',
                documentId: 'originalSheet123',
                credentials: {
                    clientId: 'google-client',
                    clientSecret: 'google-secret',
                    redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
                    refreshToken: 'google-refresh'
                },
                template: { documentId: 'template123', sheetTitle: 'Monthly' },
                dateFormat: 'yyyy.MM'
            },
            'csv-export': {
                id: 'csv-export',
                name: 'CSV',
                type: 'export',
                dateFormat: 'yyyy-MM-dd',
                transactionPath: transactions,
                balancePath: balances
            },
            'csv-import': { id: 'csv-import', name: 'CSV Input', type: 'import' },
            teller: {
                id: 'teller',
                name: 'Teller',
                type: 'import',
                appId: 'app_fixture',
                environment: 'sandbox',
                pathCertificate: '',
                pathPrivateKey: ''
            }
        },
        accounts: {
            oldPlaid: { id: 'oldPlaid', integration: 'plaid', token: 'plaid-bank-token' },
            oldTeller: {
                id: 'acc_fork',
                integration: 'teller',
                token: 'test_token_fork',
                enrollmentId: 'enr_fork',
                label: 'Fork Checking'
            },
            needsRepair: { id: 'acc_unknown', integration: 'teller', token: 'test_token_unknown' },
            manual: {
                id: 'Manual',
                integration: 'csv-import',
                paths: ['C:/bank/*.csv'],
                transformer: { Posted: 'date', Memo: 'name', Value: 'amount' },
                dateFormat: 'MM/dd/yyyy',
                negateValues: true
            }
        },
        transactions: {
            integration: 'csv-export',
            properties: ['date', 'amount', 'name', 'category', 'customColumn'],
            rules: [{ type: 'filter', conditions: [{ property: 'category', pattern: 'Transfers' }] }]
        },
        balances: { integration: 'csv-export', properties: ['account', 'current', 'customBalance'] }
    }
}

test('v2 mixed preview keeps reusable settings, never prints tokens, and apply is repeatable', () =>
    inTemp(directory => {
        const legacy = v2(directory)
        const sourceFile = write(directory, 'legacy.jsonc', legacy)
        const outputFile = path.join(directory, 'v3.jsonc')
        const source = { file: sourceFile, outputFile }
        const before = fs.readFileSync(sourceFile, 'utf8')
        const plan = previewMigration(source)
        assert.equal(plan.sourceVersion, 'v2')
        assert.deepEqual(plan.retainedAccounts.sort(), ['manual', 'oldTeller'])
        assert.equal(plan.legacyAccounts.length, 4)
        assert.equal(plan.outputBackups.length, 2)
        assert.deepEqual(plan.ruleFields, ['category'])
        assert.doesNotMatch(JSON.stringify(plan), /secret-bank|plaid-bank-token|test_token_fork|google-refresh/)
        assert.equal(fs.existsSync(outputFile), false)
        assert.throws(() => applyMigration(source, 'wrong'), /preview changed/)
        applyMigration(source, plan.reviewSha256)
        applyMigration(source, plan.reviewSha256)
        assert.equal(fs.readFileSync(sourceFile, 'utf8'), before)
        assert.equal(fs.readFileSync(plan.sourceBackupPath, 'utf8'), before)
        assert.ok(plan.outputBackups.every(item => fs.existsSync(item.backup)))
        const converted = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
        assert.equal(converted.version, 3)
        assert.equal(converted.migration.status, 'pending')
        assert.equal(converted.accounts.oldPlaid, undefined)
        assert.equal(converted.enrollments.enr_fork.token, 'test_token_fork')
        assert.equal(converted.integrations.plaid, undefined)
        assert.deepEqual(converted.transactions.properties, legacy.transactions.properties)
        assert.deepEqual(converted.balances.properties, legacy.balances.properties)
        assert.deepEqual(converted.accounts.manual.transformer, legacy.accounts.manual.transformer)
        assert.deepEqual(converted.integrations.google.template, legacy.integrations.google.template)
        assert.doesNotMatch(fs.readFileSync(outputFile, 'utf8'), /plaid-bank-token|secret-bank/)
    }))

test('CLI preview redacts secrets and pending v3 blocks fetch before output', () =>
    inTemp(directory => {
        const sourceFile = write(directory, 'legacy.jsonc', v2(directory))
        const outputFile = path.join(directory, 'v3.jsonc')
        const cli = path.join(__dirname, '..', 'lib', 'scripts', 'cli.js')
        const preview = spawnSync(
            process.execPath,
            [cli, 'migrate', '--source-file', sourceFile, '--output-config-file', outputFile],
            { encoding: 'utf8' }
        )
        assert.equal(preview.status, 0)
        assert.doesNotMatch(preview.stdout + preview.stderr, /plaid-bank-token|secret-bank|google-refresh/)
        const plan = JSON.parse(preview.stdout)
        applyMigration({ file: sourceFile, outputFile }, plan.reviewSha256)
        const fetch = spawnSync(process.execPath, [cli, 'fetch', `--config-file=${outputFile}`], { encoding: 'utf8' })
        assert.notEqual(fetch.status, 0)
        assert.match(fetch.stderr, /pending activation/)
    }))

test('v1 converts columns, template and Google settings while isolating Plaid tokens', () =>
    inTemp(directory => {
        const source = write(directory, 'v1.json', {
            BALANCE_COLUMNS: ['name', 'official_name', 'balances.current'],
            TRANSACTION_COLUMNS: ['date', 'amount', 'category.0'],
            REFERENCE_COLUMNS: ['note'],
            SHEETS_CLIENT_ID: 'client',
            SHEETS_CLIENT_SECRET: 'secret',
            SHEETS_SHEET_ID: 'originalSheet123',
            SHEETS_REFRESH_TOKEN: 'refresh',
            TEMPLATE_SHEET: { SHEET_ID: 'template', SHEET_TITLE: 'Monthly' },
            PLAID_TOKEN_old: 'bank-token',
            CATEGORY_OVERRIDES: { Store: 'Groceries' }
        })
        const plan = previewMigration({ file: source, outputFile: path.join(directory, 'v3.jsonc') })
        assert.equal(plan.sourceVersion, 'v1')
        assert.deepEqual(plan.balanceColumns, ['institution', 'account', 'current'])
        assert.deepEqual(plan.transactionColumns, ['date', 'amount', 'category', 'note'])
        assert.deepEqual(
            plan.legacyAccounts.map(item => item.sourceKey),
            ['plaid:old']
        )
        assert.ok(plan.warnings.some(item => item.includes('CATEGORY_OVERRIDES')))
        assert.doesNotMatch(JSON.stringify(plan), /bank-token|refresh/)
    }))

test('v2 Plaid-only and Teller-only variants preview without a live provider', () =>
    inTemp(directory => {
        const plaid = v2(directory)
        delete plaid.integrations.teller
        delete plaid.accounts.oldTeller
        delete plaid.accounts.needsRepair
        const plaidFile = write(directory, 'plaid-only.json', plaid)
        const plaidPlan = previewMigration({ file: plaidFile, outputFile: path.join(directory, 'plaid-v3.jsonc') })
        assert.deepEqual(
            plaidPlan.legacyAccounts.map(account => account.sourceKey),
            ['plaid:oldPlaid', 'csv:Manual']
        )
        const teller = v2(directory)
        delete teller.integrations.plaid
        delete teller.accounts.oldPlaid
        teller.accounts.oldTeller = {
            id: 'acc_fork',
            integration: 'teller',
            metadata: { enrollment: { id: 'enr_fork' } }
        }
        teller.enrollments = { enr_fork: { accessToken: 'test_token_fork' } }
        const tellerFile = write(directory, 'teller-only.json', teller)
        const tellerPlan = previewMigration({ file: tellerFile, outputFile: path.join(directory, 'teller-v3.jsonc') })
        assert.deepEqual(tellerPlan.retainedAccounts.sort(), ['manual', 'oldTeller'])
        assert.equal(
            tellerPlan.warnings.some(message => message.includes('oldTeller')),
            false
        )
    }))

test('environment migration requires a separate path and unchanged preview hash', () =>
    inTemp(directory => {
        const variable = 'MINTABLE_TEST_LEGACY_PART4'
        process.env[variable] = JSON.stringify(v2(directory))
        try {
            const outputFile = path.join(directory, 'env-v3.jsonc')
            const source = { environmentVariable: variable, outputFile }
            const plan = previewMigration(source)
            process.env[variable] = process.env[variable].replace('oldPlaid', 'changedPlaid')
            assert.throws(() => applyMigration(source, plan.reviewSha256), /preview changed/)
            process.env[variable] = JSON.stringify(v2(directory))
            applyMigration(source, plan.reviewSha256)
            assert.ok(fs.existsSync(outputFile))
            assert.ok(fs.existsSync(plan.sourceBackupPath))
        } finally {
            delete process.env[variable]
        }
    }))

test('activation requires account coverage and separate destinations, then preserves old outputs', () =>
    inTemp(directory => {
        const legacy = v2(directory)
        const sourceFile = write(directory, 'legacy.jsonc', legacy)
        const outputFile = path.join(directory, 'v3.jsonc')
        const plan = previewMigration({ file: sourceFile, outputFile })
        applyMigration({ file: sourceFile, outputFile }, plan.reviewSha256)
        const config = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
        config.accounts.acc_new = {
            id: 'acc_new',
            integration: 'teller',
            enrollmentId: 'enr_new',
            label: 'New Checking'
        }
        config.enrollments.enr_new = { id: 'enr_new', token: 'token_new' }
        fs.writeFileSync(outputFile, JSON.stringify(config, null, 2))
        const mappingFile = write(directory, 'mapping.json', {
            'plaid:oldPlaid': { localAccountId: 'checking', target: 'teller:acc_new' },
            'teller:acc_fork': { localAccountId: 'fork', target: 'teller:acc_fork' },
            'teller:acc_unknown': { localAccountId: 'unsupported', target: 'archive' },
            'csv:Manual': { localAccountId: 'manual', target: 'csv:Manual' }
        })
        const options = {
            configFile: outputFile,
            mappingFile,
            newTransactionCsv: path.join(directory, 'new-transactions.csv'),
            newBalanceCsv: path.join(directory, 'new-balances.csv'),
            cutoverMonth: '2026-04'
        }
        const hiddenBackup = plan.sourceBackupPath + '.hidden'
        fs.renameSync(plan.sourceBackupPath, hiddenBackup)
        assert.throws(() => previewActivation(options), /source backup is missing/)
        fs.renameSync(hiddenBackup, plan.sourceBackupPath)
        const activation = previewActivation(options)
        assert.equal(activation.mappedAccounts, 3)
        assert.equal(activation.archivedAccounts, 1)
        assert.ok(activation.accountNameChanges.some(change => change.sourceKey === 'plaid:oldPlaid'))
        assert.deepEqual(activation.ruleFieldsToReview, ['category'])
        assert.throws(() => applyActivation(options, 'wrong'), /preview changed/)
        applyActivation(options, activation.configSha256)
        const active = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
        assert.equal(active.migration.status, 'active')
        assert.equal(active.accounts.acc_new.localAccountId, 'checking')
        assert.equal(active.accounts.oldTeller.localAccountId, 'fork')
        assert.equal(active.accounts.manual.localAccountId, 'manual')
        assert.equal(active.integrations['csv-export'].transactionPath, options.newTransactionCsv)
        assert.equal(active.integrations['csv-export'].balancePath, options.newBalanceCsv)
        assert.equal(
            fs.readFileSync(legacy.integrations['csv-export'].transactionPath, 'utf8').includes('Coffee'),
            true
        )
        assert.equal(fs.existsSync(options.newTransactionCsv), false)
        const cli = path.join(__dirname, '..', 'lib', 'scripts', 'cli.js')
        active.integrations['csv-export'].transactionPath = legacy.integrations['csv-export'].transactionPath
        fs.writeFileSync(outputFile, JSON.stringify(active))
        const wrongDestination = spawnSync(process.execPath, [cli, 'fetch', `--config-file=${outputFile}`], {
            encoding: 'utf8'
        })
        assert.notEqual(wrongDestination.status, 0)
        assert.match(wrongDestination.stderr, /original or archive destination/)
        active.integrations['csv-export'].transactionPath = options.newTransactionCsv
        active.transactions.startDate = '2026-03-01'
        active.transactions.endDate = '2026-03-31'
        fs.writeFileSync(outputFile, JSON.stringify(active))
        const beforeCutover = spawnSync(process.execPath, [cli, 'fetch', `--config-file=${outputFile}`], {
            encoding: 'utf8'
        })
        assert.notEqual(beforeCutover.status, 0)
        assert.match(beforeCutover.stderr, /before the migration cutover/)
        assert.equal(fs.existsSync(options.newTransactionCsv), false)
    }))

test('Google activation requires a distinct archive copy and empty new destination review', () =>
    inTemp(directory => {
        const legacy = v2(directory)
        legacy.transactions.integration = 'google'
        legacy.balances.integration = 'google'
        legacy.accounts = {}
        const sourceFile = write(directory, 'legacy.jsonc', legacy)
        const outputFile = path.join(directory, 'v3.jsonc')
        const plan = previewMigration({ file: sourceFile, outputFile })
        applyMigration({ file: sourceFile, outputFile }, plan.reviewSha256)
        const mappingFile = write(directory, 'mapping.json', {})
        const basic = {
            configFile: outputFile,
            mappingFile,
            cutoverMonth: '2026-04',
            newGoogleSheetId: 'newSheet12345',
            googleArchiveId: 'archiveSheet12345'
        }
        assert.throws(() => previewActivation(basic), /Review formulas/)
        const activation = previewActivation({ ...basic, reviewedFormulas: true, emptyGoogleDestination: true })
        assert.deepEqual(activation.newDestinations, ['google:newSheet12345'])
        assert.equal(fs.existsSync(outputFile + '.pre-v3-' + activation.configSha256.slice(0, 12) + '.bak'), false)
    }))

test('reconciliation writes only complete boundary history with stable account and provider keys', () =>
    inTemp(directory => {
        const oldCsv = write(
            directory,
            'old.csv',
            'date,amount,name,accountId,transactionId\n2026-03-01,12,Coffee,old,one\n'
        )
        const newCsv = write(
            directory,
            'new.csv',
            'date,amount,name,accountId,transactionId\n2026-03-01,12,Coffee,new,a\n2026-04-02,8,Lunch,new,b\n'
        )
        const mappingFile = write(directory, 'mapping.json', {
            'plaid:old': { localAccountId: 'checking', target: 'teller:new' }
        })
        const completeMonthFile = write(directory, 'complete.json', {
            cutoverMonth: '2026-04',
            localAccountIds: ['checking']
        })
        const options = {
            oldCsv,
            newCsv,
            mappingFile,
            completeMonthFile,
            outputCsv: path.join(directory, 'merged.csv'),
            cutoverMonth: '2026-04',
            oldProvider: 'plaid',
            newProvider: 'teller'
        }
        const preview = previewReconciliation(options)
        assert.deepEqual(preview.blockers, [])
        assert.equal(preview.possibleCrossProviderMatches, 1)
        assert.equal(preview.ignoredNewBeforeCutover, 1)
        assert.throws(() => applyReconciliation(options, 'wrong'), /changed/)
        applyReconciliation(options, preview.reviewSha256)
        const rows = parse(fs.readFileSync(options.outputCsv, 'utf8'), { columns: true })
        assert.deepEqual(
            rows.map(row => row.mintableSourceKey),
            ['plaid:checking:one', 'teller:checking:b']
        )
        assert.deepEqual(
            rows.map(row => row.mintableLocalAccountId),
            ['checking', 'checking']
        )
        assert.throws(() => applyReconciliation(options, preview.reviewSha256), /already exists/)
    }))

test('reconciliation blocks missing IDs and an incomplete shared month', () =>
    inTemp(directory => {
        const oldCsv = write(
            directory,
            'old.csv',
            'date,amount,name,accountId,transactionId\n2026-04-01,12,Coffee,old,one\n'
        )
        const newCsv = write(
            directory,
            'new.csv',
            'date,amount,name,accountId,transactionId\n2026-04-02,8,Lunch,new,\n'
        )
        const mappingFile = write(directory, 'mapping.json', {
            'plaid:old': { localAccountId: 'checking', target: 'teller:new' }
        })
        const completeMonthFile = write(directory, 'complete.json', {
            cutoverMonth: '2026-04',
            localAccountIds: ['checking']
        })
        const options = {
            oldCsv,
            newCsv,
            mappingFile,
            completeMonthFile,
            outputCsv: path.join(directory, 'merged.csv'),
            cutoverMonth: '2026-04',
            oldProvider: 'plaid',
            newProvider: 'teller'
        }
        const preview = previewReconciliation(options)
        assert.ok(preview.blockers.some(item => item.includes('provider transaction ID')))
        assert.ok(preview.blockers.some(item => item.includes('Old history reaches')))
        assert.throws(() => applyReconciliation(options, preview.reviewSha256))
        assert.equal(fs.existsSync(options.outputCsv), false)
    }))
