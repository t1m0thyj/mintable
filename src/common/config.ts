import { IntegrationConfig, IntegrationId } from '../types/integrations'
import { AccountConfig } from '../types/account'
import { TransactionConfig } from '../types/transaction'
import { logInfo, logError } from './logging'
import { argv } from 'yargs'
import * as fs from 'fs'
import * as os from 'os'
import Ajv from 'ajv'
import { BalanceConfig } from '../types/balance'
import { jsonc } from 'jsonc'

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
    if (argv['config-file']) {
        const path = argv['config-file'].replace(/^~(?=$|\/|\\)/, os.homedir())
        logInfo(`Using configuration file \`${path}.\``)
        return { type: 'file', path: path }
    }

    if (process.env[DEFAULT_CONFIG_VAR]) {
        logInfo(`Using configuration variable '${DEFAULT_CONFIG_VAR}.'`)
        return { type: 'environment', variable: DEFAULT_CONFIG_VAR }
    }

    // Default to DEFAULT_CONFIG_FILE
    const path = DEFAULT_CONFIG_FILE.replace(/^~(?=$|\/|\\)/, os.homedir())
    logInfo(`Using default configuration file \`${path}.\``)
    logInfo(`You can supply either --config-file or --config-variable to specify a different configuration.`)
    return { type: 'file', path: path }
}

export const readConfig = (source: ConfigSource, checkExists?: boolean): string => {
    if (source.type === 'file') {
        try {
            const config = fs.readFileSync(source.path, 'utf8')
            logInfo('Successfully opened configuration file.')
            return config
        } catch (e) {
            if (checkExists) {
                logInfo('Unable to open config file.')
            } else {
                logError('Unable to open configuration file.', e)
                logInfo("You may want to run `mintable setup` (or `mintable migrate`) if you haven't already.")
            }
        }
    }
    if (source.type === 'environment') {
        try {
            const config = process.env[source.variable]

            if (config === undefined) {
                throw `Variable \`${source.variable}\` not defined in environment.`
            }

            logInfo('Successfully retrieved configuration variable.')
            return config
        } catch (e) {
            if (!checkExists) {
                logInfo('Unable to read config variable from env.')
            } else {
                logError('Unable to read config variable from env.', e)
            }
        }
    }
}

export const parseConfig = (configString: string): Object => {
    try {
        const parsedConfig = jsonc.parse(configString)
        logInfo('Successfully parsed configuration.')
        return parsedConfig
    } catch (e) {
        logError('Unable to parse configuration.', e)
    }
}

export const getConfigSchema = (): object => require('./config.schema.json')

export const validateConfig = (parsedConfig: Object): Config => {
    if (!parsedConfig || (parsedConfig as Config).version !== 3) {
        logError('This configuration is not v3. Preserve it for migration before using this version.')
    }
    const configSchema = getConfigSchema()

    // Validate parsed configuration object against generated JSON schema
    try {
        const validator = new Ajv()
        const valid = validator.validate(configSchema, parsedConfig)

        if (!valid) {
            logError('Unable to validate configuration.', validator.errors)
        }
    } catch (e) {
        logError('Unable to validate configuration.', e)
    }

    const validatedConfig = parsedConfig as Config
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
            fs.writeFileSync(source.path, jsonc.stringify(config, null, 2))
            logInfo('Successfully wrote configuration file.')
        } catch (e) {
            logError('Unable to write configuration file.', e)
        }
    }
    if (source.type === 'environment') {
        logError(
            'Node does not have permissions to modify global environment variables. Please use file-based configuration to make changes.'
        )
    }
}

type ConfigTransformer = (oldConfig: Config) => Config

export const updateConfig = (configTransformer: ConfigTransformer, initialize?: boolean): Config => {
    let newConfig: Config
    const configSource = getConfigSource()

    if (initialize) {
        newConfig = configTransformer(DEFAULT_CONFIG)
    } else {
        const configString = readConfig(configSource)
        const oldConfig = parseConfig(configString) as Config
        newConfig = configTransformer(oldConfig)
    }

    const validatedConfig = validateConfig(newConfig)
    writeConfig(configSource, validatedConfig)
    return validatedConfig
}
