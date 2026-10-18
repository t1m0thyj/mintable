import { getConfig } from '../common/config'
import { TellerIntegration } from '../integrations/teller/tellerIntegration'
import { GoogleIntegration } from '../integrations/google/googleIntegration'
import { logInfo } from '../common/logging'
import { Account } from '../types/account'
import { IntegrationId } from '../types/integrations'
import { parseISO, subMonths, startOfMonth } from 'date-fns'
import { CSVImportIntegration } from '../integrations/csv-import/csvImportIntegration'
import { CSVExportIntegration } from '../integrations/csv-export/csvExportIntegration'
import { applyTransactionRules } from '../common/transactionRules'

export default async () => {
    const config = getConfig()
    if (config.migration?.status === 'pending') {
        throw new Error('Migrated configuration is pending activation. Run `mintable migrate --activate` first.')
    }
    if (config.migration?.status === 'active') {
        const state = config.migration
        const google = config.integrations[IntegrationId.Google] as { documentId?: string } | undefined
        const csv = config.integrations[IntegrationId.CSVExport] as
            | {
                  transactionPath?: string
                  balancePath?: string
              }
            | undefined
        if (
            (google &&
                (config.transactions.integration === IntegrationId.Google ||
                    config.balances.integration === IntegrationId.Google) &&
                [state.originalGoogleDocumentId, state.archiveGoogleDocumentId].includes(google.documentId)) ||
            (csv &&
                ((config.transactions.integration === IntegrationId.CSVExport &&
                    csv.transactionPath === state.originalTransactionPath) ||
                    (config.balances.integration === IntegrationId.CSVExport &&
                        csv.balancePath === state.originalBalancePath)))
        ) {
            throw new Error('Migrated output points to an original or archive destination; fetch was stopped.')
        }
    }

    // Start date to fetch transactions, default to 2 months of history
    let startDate = config.transactions.startDate
        ? parseISO(config.transactions.startDate)
        : startOfMonth(subMonths(new Date(), 2))
    if (config.migration?.status === 'active' && config.migration.cutoverMonth) {
        const cutover = parseISO(`${config.migration.cutoverMonth}-01`)
        if (startDate < cutover) startDate = cutover
    }

    // End date to fetch transactions in YYYY-MM-DD format, default to current date
    let endDate = config.transactions.endDate ? parseISO(config.transactions.endDate) : new Date()
    if (startDate > endDate) throw new Error('Fetch date range ends before the migration cutover month.')

    let accounts: Account[] = []
    let teller: TellerIntegration | undefined

    for (const accountId in config.accounts) {
        const accountConfig = config.accounts[accountId]

        logInfo(`Fetching account ${accountConfig.id} using ${accountConfig.integration}.`)

        switch (accountConfig.integration) {
            case IntegrationId.CSVImport:
                const csv = new CSVImportIntegration(config)
                accounts = accounts.concat(await csv.fetchAccount(accountConfig, startDate, endDate))
                break

            case IntegrationId.Teller:
                teller = teller || new TellerIntegration(config)
                accounts = accounts.concat(await teller.fetchAccount(accountConfig, startDate, endDate))
                break

            default:
                break
        }
    }

    accounts.flat(10)

    const numTransactions = () =>
        accounts
            .map(account => (account.hasOwnProperty('transactions') ? account.transactions.length : 0))
            .reduce((a, b) => a + b, 0)

    const totalTransactions = numTransactions()

    // Transaction Rules
    if (config.transactions.rules) {
        const result = applyTransactionRules(accounts, config.transactions.rules)
        accounts = result.accounts

        logInfo(`${numTransactions()} transactions out of ${totalTransactions} total transactions matched filters.`)
        logInfo(`${result.countOverridden} out of ${totalTransactions} total transactions overridden.`)
    }

    switch (config.balances.integration) {
        case IntegrationId.Google:
            const google = new GoogleIntegration(config)
            await google.updateBalances(accounts)
            break
        case IntegrationId.CSVExport:
            const csv = new CSVExportIntegration(config)
            await csv.updateBalances(accounts)
            break
        default:
            break
    }

    switch (config.transactions.integration) {
        case IntegrationId.Google:
            const google = new GoogleIntegration(config)
            await google.updateTransactions(accounts)
            break
        case IntegrationId.CSVExport:
            const csv = new CSVExportIntegration(config)
            await csv.updateTransactions(accounts)
            break
        default:
            break
    }
}
