import { IntegrationConfig, IntegrationId } from '../types/integrations'
import { AccountConfig } from '../types/account'
import { TransactionConfig } from '../types/transaction'
import { logInfo, MintableError } from './logging'
import { argv } from 'yargs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Ajv from 'ajv'
import { BalanceConfig } from '../types/balance'
import { jsonc } from 'jsonc'
import { writeFileAtomic } from './atomicFile'
import { validateTransactionRules } from './transactionRules'

const DEFAULT_CONFIG_FILE = '~/mintable.jsonc'
const DEFAULT_CONFIG_VAR = 'MINTABLE_CONFIG'

const DEFAULT_CONFIG: Config = {
    version: 3,
    accounts: {},
    enrollments: {},
    transactions: {
        integration: IntegrationId.Google,
        properties: ['date', 'amount', 'name', 'account', 'category']
    },
    balances: {
        integration: IntegrationId.Google,
        properties: ['institution', 'account', 'type', 'current', 'available', 'limit', 'currency']
    },
    integrations: {}
}

export interface FileConfig {
    type: 'file'
    path: string
}

export interface EnvironmentConfig {
    type: 'environment'
    variable: string
}

export type ConfigSource = FileConfig | EnvironmentConfig

export interface Config {
    version: 3
    integrations: { [id: string]: IntegrationConfig }
    accounts: { [id: string]: AccountConfig }
    enrollments: { [id: string]: TellerEnrollmentConfig }
    transactions: TransactionConfig
    balances: BalanceConfig
    migration?: MigrationState
}

export interface MigrationAccount {
    sourceKey: string
    label: string
}

export interface MigrationMapping {
    localAccountId: string
    target: string
}

export interface MigrationState {
    status: 'pending' | 'active'
    sourceVersion: 'v1' | 'v2'
    sourceSha256: string
    sourceBackupPath: string
    outputBackupPaths?: string[]
    legacyAccounts: MigrationAccount[]
    originalGoogleDocumentId?: string
    originalTransactionPath?: string
    originalBalancePath?: string
    accountMappings?: { [sourceKey: string]: MigrationMapping }
    archiveGoogleDocumentId?: string
    cutoverMonth?: string
}

export interface TellerEnrollmentConfig {
    id: string
    token: string
    institution?: string
}

export const getConfigSource = (): ConfigSource => {
    const fileOption = argv['config-file']
    const variableOption = argv['config-variable']
    if (fileOption && variableOption)
        throw new MintableError('configuration', 'Choose either --config-file or --config-variable.')
    if (fileOption) {
        if (typeof fileOption !== 'string') throw new MintableError('configuration', '--config-file requires a path.')
        const resolved = resolveHomePath(fileOption)
        logInfo(`Using configuration file \`${resolved}.\``)
        return { type: 'file', path: resolved }
    }
    if (variableOption) {
        if (typeof variableOption !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableOption)) {
            throw new MintableError('configuration', '--config-variable requires an environment variable name.')
        }
        logInfo(`Using configuration variable '${variableOption}'.`)
        return { type: 'environment', variable: variableOption }
    }

    if (process.env[DEFAULT_CONFIG_VAR]) {
        logInfo(`Using configuration variable '${DEFAULT_CONFIG_VAR}.'`)
        return { type: 'environment', variable: DEFAULT_CONFIG_VAR }
    }

    // Default to DEFAULT_CONFIG_FILE
    const resolved = resolveHomePath(DEFAULT_CONFIG_FILE)
    logInfo(`Using default configuration file \`${resolved}.\``)
    logInfo(`You can supply either --config-file or --config-variable to specify a different configuration.`)
    return { type: 'file', path: resolved }
}

export const resolveHomePath = (value: string): string => path.resolve(value.replace(/^~(?=$|\/|\\)/, os.homedir()))

export const resolveConfigRelativePath = (value: string, source: ConfigSource = getConfigSource()): string => {
    const expanded = value.replace(/^~(?=$|\/|\\)/, os.homedir())
    if (path.isAbsolute(expanded)) return path.normalize(expanded)
    return path.resolve(source.type === 'file' ? path.dirname(source.path) : process.cwd(), expanded)
}

export const readConfig = (source: ConfigSource, checkExists?: boolean): string | undefined => {
    if (source.type === 'file') {
        try {
            const config = fs.readFileSync(source.path, 'utf8')
            logInfo('Successfully opened configuration file.')
            return config
        } catch (e) {
            if (checkExists && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw new MintableError(
                'configuration',
                `Unable to open configuration file ${source.path}. Run \`mintable setup\` or check the path.`,
                { cause: e }
            )
        }
    }
    if (source.type === 'environment') {
        try {
            const config = process.env[source.variable]

            if (config === undefined) {
                if (checkExists) return undefined
                throw new MintableError('configuration', `Configuration variable ${source.variable} is not defined.`)
            }

            logInfo('Successfully retrieved configuration variable.')
            return config
        } catch (e) {
            if (e instanceof MintableError) throw e
            throw new MintableError('configuration', `Unable to read configuration variable ${source.variable}.`, {
                cause: e
            })
        }
    }
}

export const parseConfig = (configString: string): Object => {
    try {
        const parsedConfig = jsonc.parse(configString)
        logInfo('Successfully parsed configuration.')
        return parsedConfig
    } catch (e) {
        throw new MintableError('configuration', 'Unable to parse configuration JSONC.', { cause: e })
    }
}

export const getConfigSchema = (): object => require('./config.schema.json')

export const validateConfig = (parsedConfig: Object): Config => {
    if (!parsedConfig || (parsedConfig as Config).version !== 3) {
        throw new MintableError(
            'configuration',
            'This configuration is not v3. Preserve it for migration before using this version.'
        )
    }
    const configSchema = getConfigSchema()

    // Validate parsed configuration object against generated JSON schema
    const validator = new Ajv()
    if (!validator.validate(configSchema, parsedConfig)) {
        const fields = (validator.errors || []).map(error => error.instancePath || error.schemaPath).join(', ')
        throw new MintableError('configuration', `Unable to validate configuration: ${fields}.`)
    }

    const validatedConfig = parsedConfig as Config
    try {
        validateTransactionRules(validatedConfig.transactions.rules)
    } catch (e) {
        throw new MintableError('configuration', (e as Error).message, { cause: e })
    }
    logInfo('Successfully validated configuration.')
    return validatedConfig
}

export const getConfig = (): Config => {
    const configSource = getConfigSource()
    const configString = readConfig(configSource)
    const parsedConfig = parseConfig(configString)
    const validatedConfig = validateConfig(parsedConfig)
    return validatedConfig
}

export const writeConfig = (source: ConfigSource, config: Config): void => {
    if (source.type === 'file') {
        try {
            writeFileAtomic(source.path, jsonc.stringify(config, null, 2))
            logInfo('Successfully wrote configuration file.')
        } catch (e) {
            throw new MintableError('configuration', `Unable to write configuration file ${source.path}.`, { cause: e })
        }
    }
    if (source.type === 'environment') {
        throw new MintableError(
            'configuration',
            'Node does not have permissions to modify global environment variables. Please use file-based configuration to make changes.'
        )
    }
}

type ConfigTransformer = (oldConfig: Config) => Config

export const updateConfig = (configTransformer: ConfigTransformer, initialize?: boolean): Config => {
    let newConfig: Config
    const configSource = getConfigSource()

    if (initialize) {
        newConfig = configTransformer(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config)
    } else {
        const configString = readConfig(configSource)
        const oldConfig = parseConfig(configString) as Config
        newConfig = configTransformer(oldConfig)
    }

    const validatedConfig = validateConfig(newConfig)
    writeConfig(configSource, validatedConfig)
    return validatedConfig
}
