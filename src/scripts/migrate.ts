import fs from 'fs'
import path from 'path'
import Ajv from 'ajv'
import { jsonc } from 'jsonc'
import { Config, MigrationMapping, getConfigSchema } from '../common/config'
import { TellerAccountConfig } from '../types/account'
import { IntegrationId } from '../types/integrations'
import { CSVExportConfig } from '../types/integrations/csv-export'
import { GoogleConfig } from '../types/integrations/google'
import { absolutePath, archiveBytes, readPrivate, replacePrivate, sha256, writeNewPrivate } from '../migration/files'
import { convertLegacy, LegacyPreview } from '../migration/legacy'

export interface MigrationSource {
    file?: string
    environmentVariable?: string
    outputFile: string
}
export interface MigrationPlan extends LegacyPreview {
    reviewSha256: string
    outputFile: string
    sourceBackupPath: string
    outputBackups: { source: string; backup: string; sha256: string }[]
}

const readSource = (source: MigrationSource): { text: string; sourcePath?: string; outputPath: string } => {
    if (Boolean(source.file) === Boolean(source.environmentVariable)) {
        throw new Error('Specify exactly one legacy source file or environment variable.')
    }
    const outputPath = absolutePath(source.outputFile)
    if (source.file) {
        const sourcePath = absolutePath(source.file)
        if (sourcePath === outputPath) throw new Error('The v3 output path must differ from the legacy source.')
        return { text: readPrivate(sourcePath), sourcePath, outputPath }
    }
    const text = process.env[source.environmentVariable]
    if (!text) throw new Error('Legacy configuration environment variable is empty or missing.')
    return { text, outputPath }
}

const existingOutputs = (config: Config, sourcePath?: string, outputPath?: string) => {
    const migration = config.migration
    const base = sourcePath ? path.dirname(sourcePath) : process.cwd()
    const paths = [migration.originalTransactionPath, migration.originalBalancePath]
        .filter((item): item is string => Boolean(item))
        .map(item => path.resolve(base, item))
    return [...new Set(paths)].filter(item => item !== sourcePath && item !== outputPath && fs.existsSync(item))
}

export function previewMigration(source: MigrationSource): MigrationPlan {
    const { text, sourcePath, outputPath } = readSource(source)
    const sourceHash = sha256(text)
    const sourceBackupPath = sourcePath
        ? `${sourcePath}.pre-v3-${sourceHash.slice(0, 12)}.bak`
        : `${outputPath}.source.pre-v3-${sourceHash.slice(0, 12)}.bak`
    const converted = convertLegacy(text, sourceBackupPath, sourcePath ? path.dirname(sourcePath) : process.cwd())
    validateV3(converted.config)
    const outputBackups = existingOutputs(converted.config, sourcePath, outputPath).map(item => {
        const hash = sha256(fs.readFileSync(item))
        return { source: item, backup: `${item}.pre-v3-${hash.slice(0, 12)}.bak`, sha256: hash }
    })
    const reviewSha256 = sha256(JSON.stringify({ sourceHash, outputBackups }))
    return {
        ...converted.preview,
        reviewSha256,
        outputFile: outputPath,
        sourceBackupPath,
        outputBackups
    }
}

export function applyMigration(source: MigrationSource, expectedReviewSha256: string): MigrationPlan {
    const preview = previewMigration(source)
    if (preview.reviewSha256 !== expectedReviewSha256) {
        throw new Error('Migration preview changed. Run the preview again and review its new hash.')
    }
    const { text, sourcePath, outputPath } = readSource(source)
    const config = convertLegacy(
        text,
        preview.sourceBackupPath,
        sourcePath ? path.dirname(sourcePath) : process.cwd()
    ).config
    config.migration.outputBackupPaths = preview.outputBackups.map(output => output.backup)
    const contents = jsonc.stringify(config, null, 2) + '\n'
    validateV3(config)
    if (fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8') !== contents) {
        throw new Error('Destination config already exists and differs; it was not changed.')
    }
    archiveBytes(sourcePath || `${outputPath}.source`, Buffer.from(text))
    for (const output of preview.outputBackups) {
        const current = fs.readFileSync(output.source)
        if (sha256(current) !== output.sha256)
            throw new Error('An output file changed since preview. Run migration preview again.')
        archiveBytes(output.source, current)
    }
    writeNewPrivate(outputPath, contents)
    return preview
}

export interface ActivationOptions {
    configFile: string
    mappingFile: string
    newGoogleSheetId?: string
    googleArchiveId?: string
    reviewedFormulas?: boolean
    emptyGoogleDestination?: boolean
    newTransactionCsv?: string
    newBalanceCsv?: string
    cutoverMonth: string
}
export interface ActivationPlan {
    configSha256: string
    configFile: string
    cutoverMonth: string
    mappedAccounts: number
    archivedAccounts: number
    newDestinations: string[]
    sourceBackupPath: string
    accountNameChanges: { sourceKey: string; oldLabel: string; newLabel: string }[]
    ruleFieldsToReview: string[]
    formulaReviewRequired: boolean
}

const readV3 = (file: string): { config: Config; text: string; path: string } => {
    const pathname = absolutePath(file)
    const text = readPrivate(pathname)
    let parsed: Config
    try {
        parsed = jsonc.parse(text) as Config
    } catch {
        throw new Error('Unable to parse v3 configuration.')
    }
    validateV3(parsed)
    if (parsed.migration?.status !== 'pending') throw new Error('Configuration is not pending migration activation.')
    return { config: parsed, text, path: pathname }
}

const readMappings = (file: string): Record<string, MigrationMapping> => {
    let parsed: unknown
    try {
        parsed = jsonc.parse(readPrivate(absolutePath(file)))
    } catch {
        throw new Error('Unable to parse account mapping file.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Account mapping must be an object.')
    return parsed as Record<string, MigrationMapping>
}

const sheetId = (value: string): boolean => /^[A-Za-z0-9_-]{10,}$/.test(value)
const month = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

function prepareActivation(options: ActivationOptions): { config: Config; plan: ActivationPlan; originalText: string } {
    const loaded = readV3(options.configFile)
    const config = loaded.config
    const state = config.migration
    if (
        !fs.existsSync(state.sourceBackupPath) ||
        sha256(fs.readFileSync(state.sourceBackupPath)) !== state.sourceSha256
    ) {
        throw new Error('Legacy source backup is missing or has changed; activation was stopped.')
    }
    if ((state.outputBackupPaths || []).some(item => !fs.existsSync(item))) {
        throw new Error('An output backup is missing; activation was stopped.')
    }
    const mappings = readMappings(options.mappingFile)
    const required = new Set(state.legacyAccounts.map(account => account.sourceKey))
    if (Object.keys(mappings).some(key => !required.has(key)) || Object.keys(mappings).length !== required.size) {
        throw new Error('Account mapping must cover every legacy bank account exactly once.')
    }
    if (!month(options.cutoverMonth)) throw new Error('Cutover month must be YYYY-MM.')
    const localIds = new Map<string, string>()
    const targets = new Set<string>()
    const accountNameChanges: ActivationPlan['accountNameChanges'] = []
    let archivedAccounts = 0
    for (const [sourceKey, mapping] of Object.entries(mappings)) {
        if (!mapping || typeof mapping !== 'object' || !/^[A-Za-z0-9_-]{1,128}$/.test(mapping.localAccountId)) {
            throw new Error(`Invalid local account identity for ${sourceKey}.`)
        }
        if (typeof mapping.target !== 'string') throw new Error(`Invalid target for ${sourceKey}.`)
        if (mapping.target === 'archive') {
            archivedAccounts++
        } else {
            if (targets.has(mapping.target))
                throw new Error('Several legacy accounts point to one active account; review this mapping.')
            targets.add(mapping.target)
            const [provider, ...pieces] = mapping.target.split(':')
            const id = pieces.join(':')
            const entry = Object.values(config.accounts).find(
                account =>
                    account.id === id &&
                    account.integration === (provider === 'csv' ? IntegrationId.CSVImport : IntegrationId.Teller)
            )
            if (!entry || !['csv', 'teller'].includes(provider)) {
                throw new Error(`Mapped target does not exist in the v3 config: ${mapping.target}.`)
            }
            const oldLabel = state.legacyAccounts.find(account => account.sourceKey === sourceKey)?.label || sourceKey
            const newLabel =
                entry.integration === IntegrationId.Teller ? (entry as TellerAccountConfig).label : entry.id
            if (oldLabel !== newLabel) accountNameChanges.push({ sourceKey, oldLabel, newLabel })
            entry.localAccountId = mapping.localAccountId
        }
        const prior = localIds.get(mapping.localAccountId)
        if (prior && prior !== mapping.target) throw new Error('One local account identity maps to different targets.')
        localIds.set(mapping.localAccountId, mapping.target)
        if ((sourceKey.startsWith('teller:') || sourceKey.startsWith('csv:')) && mapping.target !== sourceKey) {
            const [oldProvider, ...oldIdParts] = sourceKey.split(':')
            const oldId = oldIdParts.join(':')
            for (const [key, account] of Object.entries(config.accounts)) {
                if (
                    account.id === oldId &&
                    account.integration === (oldProvider === 'csv' ? IntegrationId.CSVImport : IntegrationId.Teller)
                )
                    delete config.accounts[key]
            }
        }
    }
    for (const [id] of Object.entries(config.enrollments)) {
        if (
            !Object.values(config.accounts).some(
                account =>
                    account.integration === IntegrationId.Teller && (account as TellerAccountConfig).enrollmentId === id
            )
        )
            delete config.enrollments[id]
    }
    for (const target of targets) {
        const [provider, ...pieces] = target.split(':')
        const id = pieces.join(':')
        if (
            !Object.values(config.accounts).some(
                account =>
                    account.id === id &&
                    account.integration === (provider === 'csv' ? IntegrationId.CSVImport : IntegrationId.Teller)
            )
        ) {
            throw new Error(`Mapped target was removed during activation: ${target}.`)
        }
    }
    const newDestinations: string[] = []
    const usesGoogle =
        config.transactions.integration === IntegrationId.Google || config.balances.integration === IntegrationId.Google
    if (usesGoogle) {
        const oldId = state.originalGoogleDocumentId
        if (
            !oldId ||
            !sheetId(options.newGoogleSheetId || '') ||
            !sheetId(options.googleArchiveId || '') ||
            new Set([oldId, options.newGoogleSheetId, options.googleArchiveId]).size !== 3
        ) {
            throw new Error('Supply distinct original, archive-copy, and new Google spreadsheet IDs.')
        }
        if (!options.reviewedFormulas || !options.emptyGoogleDestination) {
            throw new Error('Review formulas and confirm the new Google destination has no financial history.')
        }
        ;(config.integrations.google as GoogleConfig).documentId = options.newGoogleSheetId
        state.archiveGoogleDocumentId = options.googleArchiveId
        newDestinations.push(`google:${options.newGoogleSheetId}`)
    }
    const csv = config.integrations['csv-export'] as CSVExportConfig | undefined
    if (
        config.transactions.integration === IntegrationId.CSVExport ||
        config.balances.integration === IntegrationId.CSVExport
    ) {
        if (!csv) throw new Error('CSV export configuration is missing.')
        for (const [kind, supplied, original] of [
            ['transactions', options.newTransactionCsv, state.originalTransactionPath],
            ['balances', options.newBalanceCsv, state.originalBalancePath]
        ] as const) {
            const used =
                kind === 'transactions'
                    ? config.transactions.integration === IntegrationId.CSVExport
                    : config.balances.integration === IntegrationId.CSVExport
            if (!used) continue
            if (!supplied || !path.isAbsolute(supplied)) throw new Error(`Supply an absolute new ${kind} CSV path.`)
            const destination = absolutePath(supplied)
            if (destination === original || fs.existsSync(destination)) {
                throw new Error(`New ${kind} CSV path must differ from the old path and not exist yet.`)
            }
            if (kind === 'transactions') csv.transactionPath = destination
            else csv.balancePath = destination
            newDestinations.push(destination)
        }
        if (
            new Set(newDestinations.filter(item => !item.startsWith('google:'))).size !==
            newDestinations.filter(item => !item.startsWith('google:')).length
        ) {
            throw new Error('New CSV destinations must be distinct.')
        }
    }
    state.accountMappings = mappings
    state.cutoverMonth = options.cutoverMonth
    state.status = 'active'
    validateV3(config)
    return {
        config,
        originalText: loaded.text,
        plan: {
            configSha256: sha256(loaded.text),
            configFile: loaded.path,
            cutoverMonth: options.cutoverMonth,
            mappedAccounts: targets.size,
            archivedAccounts,
            newDestinations,
            sourceBackupPath: state.sourceBackupPath,
            accountNameChanges,
            ruleFieldsToReview: [
                ...new Set(
                    (config.transactions.rules || []).flatMap(rule =>
                        rule.conditions
                            .map(condition => condition.property)
                            .concat(rule.type === 'override' ? [rule.property] : [])
                    )
                )
            ].filter(field => ['category', 'account', 'institution', 'name'].includes(field)),
            formulaReviewRequired: usesGoogle
        }
    }
}

export function previewActivation(options: ActivationOptions): ActivationPlan {
    return prepareActivation(options).plan
}

export function applyActivation(options: ActivationOptions, expectedConfigSha256: string): ActivationPlan {
    const prepared = prepareActivation(options)
    if (expectedConfigSha256 !== prepared.plan.configSha256) {
        throw new Error('Activation preview changed. Review the new configuration hash.')
    }
    archiveBytes(prepared.plan.configFile, Buffer.from(prepared.originalText))
    if (sha256(readPrivate(prepared.plan.configFile)) !== expectedConfigSha256) {
        throw new Error('Pending configuration changed during activation.')
    }
    replacePrivate(prepared.plan.configFile, jsonc.stringify(prepared.config, null, 2) + '\n')
    return prepared.plan
}

const validateV3 = (config: Config): void => {
    const validator = new Ajv().compile(getConfigSchema())
    if (!validator(config))
        throw new Error('Converted v3 configuration failed schema validation; source was not changed.')
}

const value = (args: string[], key: string): string | undefined => {
    const index = args.indexOf(`--${key}`)
    if (index >= 0) return args[index + 1]
    return args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
}
const flag = (args: string[], key: string): boolean => args.includes(`--${key}`)

export default async () => {
    const args = process.argv.slice(3)
    if (flag(args, 'activate')) {
        const options: ActivationOptions = {
            configFile: value(args, 'config-file') || '',
            mappingFile: value(args, 'account-map-file') || '',
            newGoogleSheetId: value(args, 'new-google-sheet-id'),
            googleArchiveId: value(args, 'google-archive-id'),
            reviewedFormulas: flag(args, 'reviewed-formulas'),
            emptyGoogleDestination: flag(args, 'empty-google-destination'),
            newTransactionCsv: value(args, 'new-transactions-csv'),
            newBalanceCsv: value(args, 'new-balances-csv'),
            cutoverMonth: value(args, 'cutover-month') || ''
        }
        const plan = flag(args, 'apply')
            ? applyActivation(options, value(args, 'expect-sha256') || '')
            : previewActivation(options)
        console.log(JSON.stringify(plan, null, 2))
        return
    }
    const sourceFile = value(args, 'source-file') || value(args, 'old-config-file')
    const sourceEnv = value(args, 'source-env')
    const output = value(args, 'output-config-file') || (sourceFile ? `${sourceFile}.v3.jsonc` : '')
    if (!output) throw new Error('Environment-based migration requires --output-config-file.')
    const source = { file: sourceFile, environmentVariable: sourceEnv, outputFile: output }
    const plan = flag(args, 'apply')
        ? applyMigration(source, value(args, 'expect-sha256') || '')
        : previewMigration(source)
    console.log(JSON.stringify(plan, null, 2))
}
