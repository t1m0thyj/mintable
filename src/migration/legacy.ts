import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import { jsonc } from 'jsonc'
import { Config, MigrationAccount } from '../common/config'
import { AccountConfig, CSVAccountConfig, TellerAccountConfig } from '../types/account'
import { IntegrationConfig, IntegrationId, IntegrationType } from '../types/integrations'
import { GoogleConfig, defaultGoogleConfig } from '../types/integrations/google'
import { CSVExportConfig } from '../types/integrations/csv-export'
import { CSVImportConfig } from '../types/integrations/csv-import'
import { TellerConfig } from '../types/integrations/teller'
import { TransactionConfig } from '../types/transaction'
import { BalanceConfig } from '../types/balance'

type RecordValue = Record<string, unknown>
const record = (value: unknown, name: string): RecordValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`Invalid ${name} in legacy configuration.`)
    return value as RecordValue
}
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const optional = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const unique = (values: string[]): string[] => [...new Set(values)]
const safeKey = (value: string): void => {
    if (['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error('Unsafe legacy object key.')
}
const legacyPath = (value: string, baseDirectory: string): string =>
    path.resolve(baseDirectory, value.replace(/^~(?=$|[\\/])/, os.homedir()))

export interface LegacyPreview {
    sourceVersion: 'v1' | 'v2'
    sourceSha256: string
    legacyAccounts: MigrationAccount[]
    retainedAccounts: string[]
    retainedIntegrations: string[]
    transactionColumns: string[]
    balanceColumns: string[]
    ruleFields: string[]
    warnings: string[]
}

const copyOutputConfig = (raw: RecordValue, kind: 'transactions' | 'balances'): TransactionConfig | BalanceConfig => {
    const source = record(raw[kind], kind)
    if (source.integration !== IntegrationId.Google && source.integration !== IntegrationId.CSVExport) {
        throw new Error(`Unsupported ${kind} export integration.`)
    }
    const result: TransactionConfig | BalanceConfig = { integration: source.integration }
    if (source.properties !== undefined) {
        if (!Array.isArray(source.properties) || source.properties.some(item => typeof item !== 'string')) {
            throw new Error(`Invalid ${kind} columns.`)
        }
        result.properties = clone(source.properties)
    }
    if (kind === 'transactions') {
        const tx = result as TransactionConfig
        if (source.rules !== undefined) {
            if (!Array.isArray(source.rules)) throw new Error('Invalid transaction rules.')
            tx.rules = clone(source.rules)
        }
        if (source.startDate !== undefined) tx.startDate = str(source.startDate)
        if (source.endDate !== undefined) tx.endDate = str(source.endDate)
    }
    return result
}

const copyIntegration = (key: string, raw: unknown, baseDirectory: string): IntegrationConfig | undefined => {
    const item = record(raw, `${key} integration`)
    if (key === 'plaid') return undefined
    if (key === IntegrationId.Google) {
        const creds = record(item.credentials, 'Google credentials')
        const credentials: GoogleConfig['credentials'] = {
            clientId: str(creds.clientId),
            clientSecret: str(creds.clientSecret),
            redirectUri: str(creds.redirectUri, defaultGoogleConfig.credentials.redirectUri)
        }
        for (const name of ['accessToken', 'refreshToken', 'tokenType'] as const) {
            if (typeof creds[name] === 'string') credentials[name] = creds[name]
        }
        if (Array.isArray(creds.scope)) credentials.scope = strings(creds.scope)
        if (typeof creds.expiryDate === 'number') credentials.expiryDate = creds.expiryDate
        const integration: GoogleConfig = {
            id: IntegrationId.Google,
            type: IntegrationType.Export,
            name: str(item.name, 'Google Sheets'),
            credentials,
            documentId: str(item.documentId)
        }
        if (typeof item.dateFormat === 'string') integration.dateFormat = item.dateFormat
        if (item.template) {
            const template = record(item.template, 'Google template')
            integration.template = { documentId: str(template.documentId), sheetTitle: str(template.sheetTitle) }
        }
        return integration
    }
    if (key === IntegrationId.CSVExport) {
        const integration: CSVExportConfig = {
            id: IntegrationId.CSVExport,
            type: IntegrationType.Export,
            name: str(item.name, 'CSV Export'),
            dateFormat: str(item.dateFormat, 'yyyy-MM-dd')
        }
        if (typeof item.transactionPath === 'string')
            integration.transactionPath = legacyPath(item.transactionPath, baseDirectory)
        if (typeof item.balancePath === 'string') integration.balancePath = legacyPath(item.balancePath, baseDirectory)
        return integration
    }
    if (key === IntegrationId.CSVImport) {
        const integration: CSVImportConfig = {
            id: IntegrationId.CSVImport,
            type: IntegrationType.Import,
            name: str(item.name, 'CSV Import')
        }
        return integration
    }
    if (key === IntegrationId.Teller) {
        const environment = item.environment
        if (environment !== undefined && !['sandbox', 'development', 'production'].includes(String(environment))) {
            throw new Error('Unsupported Teller environment in legacy configuration.')
        }
        const integration: TellerConfig = {
            id: IntegrationId.Teller,
            type: IntegrationType.Import,
            name: str(item.name, 'Teller'),
            appId: str(item.appId),
            pathCertificate: item.pathCertificate ? legacyPath(str(item.pathCertificate), baseDirectory) : '',
            pathPrivateKey: item.pathPrivateKey ? legacyPath(str(item.pathPrivateKey), baseDirectory) : '',
            environment: (environment || 'development') as TellerConfig['environment']
        }
        return integration
    }
    throw new Error(`Unsupported legacy integration: ${key}.`)
}

const copyCsvAccount = (key: string, raw: RecordValue, baseDirectory: string): CSVAccountConfig => {
    const transformer = record(raw.transformer, `CSV account ${key} transformer`)
    const mapped: CSVAccountConfig['transformer'] = {}
    for (const [column, target] of Object.entries(transformer)) {
        if (typeof target !== 'string') throw new Error(`Invalid CSV account ${key} transformer.`)
        mapped[column] = target as keyof import('../types/transaction').Transaction
    }
    if (!Array.isArray(raw.paths) || raw.paths.some(value => typeof value !== 'string')) {
        throw new Error(`Invalid CSV account ${key} paths.`)
    }
    const account: CSVAccountConfig = {
        id: str(raw.id, key),
        integration: IntegrationId.CSVImport,
        paths: (raw.paths as string[]).map(value => legacyPath(value, baseDirectory)),
        transformer: mapped,
        dateFormat: str(raw.dateFormat)
    }
    if (typeof raw.negateValues === 'boolean') account.negateValues = raw.negateValues
    if (typeof raw.localAccountId === 'string') account.localAccountId = raw.localAccountId
    return account
}

const v1Columns = (raw: RecordValue, key: string, replacements: Record<string, string>): string[] => {
    const columns = raw[key]
    if (!Array.isArray(columns) || columns.some(value => typeof value !== 'string')) {
        throw new Error(`Missing or invalid v1 ${key}.`)
    }
    return columns.map(value => replacements[value] || value)
}

export function convertLegacy(
    text: string,
    backupPath: string,
    baseDirectory = process.cwd()
): { config: Config; preview: LegacyPreview } {
    let parsed: unknown
    try {
        parsed = jsonc.parse(text)
    } catch {
        throw new Error('Unable to parse legacy JSON or JSONC configuration.')
    }
    const raw = record(parsed, 'legacy configuration')
    if (raw.version === 3) throw new Error('Source is already a v3 configuration.')
    const sourceVersion: 'v1' | 'v2' = raw.integrations !== undefined ? 'v2' : 'v1'
    if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) {
        throw new Error('Unsupported legacy configuration version.')
    }
    const sourceSha256 = createHash('sha256').update(text).digest('hex')
    const config: Config = {
        version: 3,
        integrations: {},
        accounts: {},
        enrollments: {},
        transactions: { integration: IntegrationId.Google },
        balances: { integration: IntegrationId.Google },
        migration: { status: 'pending', sourceVersion, sourceSha256, sourceBackupPath: backupPath, legacyAccounts: [] }
    }
    const warnings: string[] = []
    if (sourceVersion === 'v2') {
        const integrations = record(raw.integrations, 'integrations')
        for (const [key, value] of Object.entries(integrations)) {
            safeKey(key)
            const copied = copyIntegration(key, value, baseDirectory)
            if (copied) config.integrations[key] = copied
        }
        config.transactions = copyOutputConfig(raw, 'transactions') as TransactionConfig
        config.balances = copyOutputConfig(raw, 'balances') as BalanceConfig
        const accounts = record(raw.accounts, 'accounts')
        const sourceEnrollments = raw.enrollments ? record(raw.enrollments, 'enrollments') : {}
        for (const [key, value] of Object.entries(accounts)) {
            safeKey(key)
            const account = record(value, `account ${key}`)
            if (account.integration === IntegrationId.CSVImport) {
                config.accounts[key] = copyCsvAccount(key, account, baseDirectory)
                config.migration.legacyAccounts.push({
                    sourceKey: `csv:${str(account.id, key)}`,
                    label: str(account.id, key)
                })
                continue
            }
            if (account.integration !== 'plaid' && account.integration !== IntegrationId.Teller) {
                throw new Error(`Unsupported legacy account provider for ${key}.`)
            }
            const provider = account.integration as 'plaid' | 'teller'
            const sourceKey = `${provider}:${str(account.id, key)}`
            const label = str(account.label, str(account.name, str(account.id, key)))
            config.migration.legacyAccounts.push({ sourceKey, label })
            if (provider === 'plaid') continue
            const metadata =
                account.metadata && typeof account.metadata === 'object' ? (account.metadata as RecordValue) : {}
            const metadataEnrollment =
                metadata.enrollment && typeof metadata.enrollment === 'object'
                    ? (metadata.enrollment as RecordValue)
                    : {}
            const accountEnrollment =
                account.enrollment && typeof account.enrollment === 'object' ? (account.enrollment as RecordValue) : {}
            const enrollmentId =
                optional(account.enrollmentId) ||
                optional(account.enrollment_id) ||
                optional(metadata.enrollmentId) ||
                optional(metadata.enrollment_id) ||
                optional(metadataEnrollment.id) ||
                optional(accountEnrollment.id)
            const savedEnrollment = enrollmentId ? sourceEnrollments[enrollmentId] : undefined
            const savedToken =
                savedEnrollment && typeof savedEnrollment === 'object'
                    ? optional((savedEnrollment as RecordValue).token) ||
                      optional((savedEnrollment as RecordValue).accessToken)
                    : undefined
            const token = optional(account.token) || optional(account.accessToken) || optional(savedToken)
            if (!enrollmentId || !token || !/^enr_[A-Za-z0-9_-]+$/.test(enrollmentId)) {
                warnings.push(`Teller account ${sourceKey} needs reconnection; enrollment metadata was unavailable.`)
                continue
            }
            if (config.enrollments[enrollmentId] && config.enrollments[enrollmentId].token !== token) {
                throw new Error(`Conflicting access tokens for Teller enrollment ${enrollmentId}.`)
            }
            config.enrollments[enrollmentId] = { id: enrollmentId, token }
            const retained: TellerAccountConfig = {
                id: str(account.id, key),
                integration: IntegrationId.Teller,
                enrollmentId,
                label
            }
            config.accounts[key] = retained
        }
    } else {
        const balanceMap = {
            name: 'institution',
            official_name: 'account',
            'balances.available': 'available',
            'balances.current': 'current',
            'balances.limit': 'limit'
        }
        const transactionMap = { 'category.0': 'category', 'category.1': 'category' }
        const balanceColumns = v1Columns(raw, 'BALANCE_COLUMNS', balanceMap)
        const transactionColumns = v1Columns(raw, 'TRANSACTION_COLUMNS', transactionMap)
        config.transactions = {
            integration: IntegrationId.Google,
            properties: unique([...transactionColumns, ...strings(raw.REFERENCE_COLUMNS)])
        }
        config.balances = { integration: IntegrationId.Google, properties: balanceColumns }
        const template =
            raw.TEMPLATE_SHEET && typeof raw.TEMPLATE_SHEET === 'object' ? (raw.TEMPLATE_SHEET as RecordValue) : {}
        const googleConfig: GoogleConfig = {
            id: IntegrationId.Google,
            type: IntegrationType.Export,
            name: 'Google Sheets',
            documentId: str(raw.SHEETS_SHEET_ID),
            credentials: {
                clientId: str(raw.SHEETS_CLIENT_ID),
                clientSecret: str(raw.SHEETS_CLIENT_SECRET),
                redirectUri: defaultGoogleConfig.credentials.redirectUri,
                accessToken: optional(raw.SHEETS_ACCESS_TOKEN),
                refreshToken: optional(raw.SHEETS_REFRESH_TOKEN),
                tokenType: optional(raw.SHEETS_TOKEN_TYPE),
                expiryDate: Number.isFinite(Number(raw.SHEETS_EXPIRY_DATE))
                    ? Number(raw.SHEETS_EXPIRY_DATE)
                    : undefined,
                scope: defaultGoogleConfig.credentials.scope
            }
        }
        if (template.SHEET_ID && template.SHEET_TITLE) {
            googleConfig.template = { documentId: str(template.SHEET_ID), sheetTitle: str(template.SHEET_TITLE) }
        }
        config.integrations.google = googleConfig
        for (const [key] of Object.entries(raw)) {
            if (key.startsWith('PLAID_TOKEN_')) {
                config.migration.legacyAccounts.push({
                    sourceKey: `plaid:${key.slice('PLAID_TOKEN_'.length)}`,
                    label: key.slice('PLAID_TOKEN_'.length)
                })
            }
        }
        if (raw.CATEGORY_OVERRIDES !== undefined)
            warnings.push('v1 CATEGORY_OVERRIDES requires manual review; original remains in the source backup.')
    }
    const google = config.integrations.google as GoogleConfig | undefined
    const csv = config.integrations['csv-export'] as CSVExportConfig | undefined
    if (
        (config.transactions.integration === IntegrationId.Google ||
            config.balances.integration === IntegrationId.Google) &&
        !google
    )
        throw new Error('Legacy Google output settings are missing.')
    if (
        (config.transactions.integration === IntegrationId.CSVExport ||
            config.balances.integration === IntegrationId.CSVExport) &&
        !csv
    )
        throw new Error('Legacy CSV output settings are missing.')
    if (
        Object.values(config.accounts).some(account => account.integration === IntegrationId.CSVImport) &&
        !config.integrations[IntegrationId.CSVImport]
    )
        throw new Error('Legacy CSV import settings are missing.')
    if (google) config.migration.originalGoogleDocumentId = google.documentId
    if (csv?.transactionPath) config.migration.originalTransactionPath = csv.transactionPath
    if (csv?.balancePath) config.migration.originalBalancePath = csv.balancePath
    if (config.migration.legacyAccounts.some(account => account.sourceKey.startsWith('plaid:'))) {
        warnings.push(
            'Plaid accounts require Teller reconnection or an explicit archive-only mapping; Plaid tokens are not transferred.'
        )
    }
    if (google) warnings.push('Review Google spreadsheet formulas and duplicate the spreadsheet before activation.')
    const ruleFields = unique(
        (config.transactions.rules || []).flatMap(rule =>
            rule.conditions.map(condition => condition.property).concat(rule.type === 'override' ? [rule.property] : [])
        )
    )
    if (ruleFields.some(field => ['category', 'account', 'institution', 'name'].includes(field))) {
        warnings.push('Review transaction rules against Teller categories and account names before activation.')
    }
    return {
        config,
        preview: {
            sourceVersion,
            sourceSha256,
            legacyAccounts: config.migration.legacyAccounts,
            retainedAccounts: Object.keys(config.accounts),
            retainedIntegrations: Object.keys(config.integrations),
            transactionColumns: config.transactions.properties || [],
            balanceColumns: config.balances.properties || [],
            ruleFields,
            warnings
        }
    }
}
