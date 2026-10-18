import { Config } from '../../common/config'
import { IntegrationId } from '../../types/integrations'
import { logInfo } from '../../common/logging'
import { AccountConfig, Account, CSVAccountConfig } from '../../types/account'
import { Transaction } from '../../types/transaction'
import { CSVImportConfig } from '../../types/integrations/csv-import'
import { globSync } from 'glob'
import { readFileSync } from 'fs'
import { parse } from 'csv-parse/sync'
import * as dateFns from 'date-fns'
import { createHash } from 'crypto'
import { resolve as resolvePath } from 'path'

export class CSVImportIntegration {
    config: Config
    CSVImportConfig: CSVImportConfig

    constructor(config: Config) {
        this.config = config
        this.CSVImportConfig = this.config.integrations[IntegrationId.CSVImport] as CSVImportConfig
    }

    public fetchAccount = async (accountConfig: AccountConfig, startDate: Date, endDate: Date): Promise<Account> => {
        const CSVAccountConfig = accountConfig as CSVAccountConfig
        if (!Array.isArray(CSVAccountConfig.paths) || CSVAccountConfig.paths.length === 0) {
            throw new Error(`CSV account ${accountConfig.id} has no source files.`)
        }

        const account: Account = {
            account: accountConfig.id,
            accountId: accountConfig.localAccountId || accountConfig.id,
            integration: accountConfig.integration,
            transactions: []
        }

        // parse file globs
        account.transactions = CSVAccountConfig.paths
            .map(path => {
                try {
                    const files = globSync(path)

                    if (files.length === 0) {
                        throw new Error(`No files resolved for path glob ${path}.`)
                    }

                    return files.map(match => {
                        try {
                            const rows = parse(readFileSync(match), {
                                columns: true,
                                skip_empty_lines: true
                            })

                            const duplicates = new Map<string, number>()
                            const transactions: Transaction[] = rows.map(inputRow => {
                                const outputRow = {} as Transaction

                                Object.keys(CSVAccountConfig.transformer).map(inputColumn => {
                                    // Concatenate multiple columns
                                    if (inputColumn.includes('+')) {
                                        outputRow[CSVAccountConfig.transformer[inputColumn] as string] = inputColumn
                                            .split('+')
                                            .map(c => inputRow[c])
                                            .join(' - ')
                                    } else {
                                        outputRow[CSVAccountConfig.transformer[inputColumn] as string] =
                                            inputRow[inputColumn]
                                    }
                                })

                                // Remove spaces/special characters from amount field
                                if (outputRow.hasOwnProperty('amount')) {
                                    const pattern = new RegExp(`[^0-9\.\-]*`, 'gi')
                                    outputRow['amount'] = parseFloat(
                                        outputRow['amount'].toString().replace(pattern, '')
                                    )
                                }

                                // Parse dates
                                if (outputRow.hasOwnProperty('date')) {
                                    outputRow['date'] = dateFns.parse(
                                        outputRow['date'].toString(),
                                        CSVAccountConfig.dateFormat,
                                        new Date()
                                    )
                                }

                                if (CSVAccountConfig.negateValues === true && outputRow.hasOwnProperty('amount')) {
                                    outputRow['amount'] = -outputRow['amount']
                                }

                                if (!dateFns.isValid(outputRow.date) || !Number.isFinite(outputRow.amount)) {
                                    throw new Error('CSV row has an invalid date or amount.')
                                }
                                outputRow.dateOnly = dateFns.format(outputRow.date, 'yyyy-MM-dd')

                                if (!outputRow.hasOwnProperty('account')) {
                                    outputRow.account = CSVAccountConfig.id
                                }

                                if (!outputRow.hasOwnProperty('pending')) {
                                    outputRow.pending = false
                                }

                                outputRow.integration = IntegrationId.CSVImport
                                outputRow.accountId = accountConfig.localAccountId || accountConfig.id
                                if (!outputRow.transactionId) {
                                    const source = JSON.stringify([resolvePath(match), inputRow])
                                    const ordinal = duplicates.get(source) || 0
                                    duplicates.set(source, ordinal + 1)
                                    outputRow.transactionId = createHash('sha256')
                                        .update(`${source}:${ordinal}`)
                                        .digest('hex')
                                }

                                return outputRow
                            })

                            logInfo(`Successfully imported transactions from ${match}.`)

                            return transactions.filter(transaction => {
                                if (transaction.hasOwnProperty('date')) {
                                    return transaction.date >= startDate && transaction.date <= endDate
                                }
                                return true
                            })
                        } catch (e) {
                            throw new Error(`Error importing transactions from ${match}.`, { cause: e })
                        }
                    })
                } catch (e) {
                    if (e instanceof Error) throw e
                    throw new Error(`Error resolving path glob ${path}.`, { cause: e })
                }
            })
            .flat(10)

        logInfo(`Successfully imported transactions for integration ${IntegrationId.CSVImport}`, account)
        return account
    }
}
