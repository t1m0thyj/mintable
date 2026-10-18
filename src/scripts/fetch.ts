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
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate > endDate) {
        throw new Error('Fetch date range is invalid or ends before the migration cutover month.')
    }

    let accounts: Account[] = []
    let teller: TellerIntegration | undefined

    if (Object.keys(config.accounts).length === 0) throw new Error('No accounts are configured; output was kept.')

    for (const accountId in config.accounts) {
        const accountConfig = config.accounts[accountId]

        logInfo(`Fetching account ${accountConfig.id} using ${accountConfig.integration}.`)

        let fetched: Account[]
        switch (accountConfig.integration) {
            case IntegrationId.CSVImport:
                const csv = new CSVImportIntegration(config)
                fetched = [await csv.fetchAccount(accountConfig, startDate, endDate)]
                break

            case IntegrationId.Teller:
                teller = teller || new TellerIntegration(config)
                fetched = await teller.fetchAccount(accountConfig, startDate, endDate)
                break

            default:
                throw new Error(`Unsupported account provider: ${accountConfig.integration}.`)
        }
        if (
            !Array.isArray(fetched) ||
            fetched.length === 0 ||
            fetched.some(account => !account || !Array.isArray(account.transactions))
        ) {
            throw new Error(
                `Account ${accountConfig.id} did not return a complete transaction dataset; output was kept.`
            )
        }
        accounts.push(...fetched)
    }

    for (const account of accounts) {
        for (const transaction of account.transactions) {
            if (
                !(transaction.date instanceof Date) ||
                isNaN(transaction.date.getTime()) ||
                !Number.isFinite(transaction.amount)
            ) {
                throw new Error('An account returned an invalid transaction date or amount; output was kept.')
            }
        }
    }

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

    const googleBalances = config.balances.integration === IntegrationId.Google
    const googleTransactions = config.transactions.integration === IntegrationId.Google
    if (googleBalances || googleTransactions) {
        const google = new GoogleIntegration(config)
        await google.updateAll(accounts, startDate, endDate, googleBalances, googleTransactions)
    }

    switch (config.balances.integration) {
        case IntegrationId.Google:
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
            break
        case IntegrationId.CSVExport:
            const csv = new CSVExportIntegration(config)
            await csv.updateTransactions(accounts)
            break
        default:
            break
    }
}
