import { Config } from '../../common/config'
import { writeFileAtomic } from '../../common/atomicFile'
import { IntegrationId } from '../../types/integrations'
import { logInfo } from '../../common/logging'
import { Account } from '../../types/account'
import { CSVExportConfig } from '../../types/integrations/csv-export'
import { stringify } from 'csv-stringify/sync'
import { format, isValid, parseISO } from 'date-fns'

// CSV consumers often open files in spreadsheet software. Prefix dangerous text so it
// remains text on import; keep amounts and balances as actual numeric CSV fields.
export function spreadsheetSafeText(value: string): string {
    return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value
}

export class CSVExportIntegration {
    config: Config
    CSVExportConfig: CSVExportConfig

    constructor(config: Config) {
        this.config = config
        this.CSVExportConfig = config.integrations[IntegrationId.CSVExport] as CSVExportConfig
    }

    private render(rows: Record<string, unknown>[], columns: string[]): string {
        if (!columns?.length) throw new Error('CSV export requires configured columns.')
        return stringify(
            rows.map(row =>
                Object.fromEntries(
                    columns.map(column => {
                        const value = row[column]
                        return [column, typeof value === 'string' ? spreadsheetSafeText(value) : (value ?? '')]
                    })
                )
            ),
            { header: true, columns }
        )
    }

    public updateTransactions = async (accounts: Account[]): Promise<void> => {
        const transactions = accounts.flatMap(account => account.transactions || [])
        const rows = transactions.map(transaction => {
            const date = transaction.dateOnly ? parseISO(transaction.dateOnly) : transaction.date
            if (!(date instanceof Date) || !isValid(date))
                throw new Error('Cannot export an invalid CSV transaction date.')
            return { ...transaction, date: format(date, this.CSVExportConfig.dateFormat || 'yyyy-MM-dd') }
        })
        const data = this.render(rows, this.config.transactions.properties)
        writeFileAtomic(this.CSVExportConfig.transactionPath, data)
        logInfo(`Successfully exported ${transactions.length} transactions to CSV.`)
    }

    public updateBalances = async (accounts: Account[]): Promise<void> => {
        const data = this.render(accounts as unknown as Record<string, unknown>[], this.config.balances.properties)
        writeFileAtomic(this.CSVExportConfig.balancePath, data)
        logInfo(`Successfully exported ${accounts.length} account balances to CSV.`)
    }
}
