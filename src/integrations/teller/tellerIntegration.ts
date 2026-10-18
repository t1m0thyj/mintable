import { format, subDays, subMonths } from 'date-fns'
import { Config } from '../../common/config'
import { TellerConfig, TellerTransaction } from '../../types/integrations/teller'
import { IntegrationId } from '../../types/integrations'
import { logInfo, logWarn } from '../../common/logging'
import { AccountConfig, Account, TellerAccountConfig } from '../../types/account'
import { TellerClient, TellerError } from './tellerClient'
import {
    normalizeTellerAccount,
    normalizeTellerTransaction,
    parseTellerAccount,
    parseTellerBalances,
    parseTellerTransactions
} from './tellerNormalizer'

const PAGE_SIZE = 100
const MAX_PAGES = 1000

export class TellerIntegration {
    config: Config
    tellerConfig: TellerConfig
    client: Pick<TellerClient, 'requestJson'>

    constructor(config: Config, client?: Pick<TellerClient, 'requestJson'>) {
        this.config = config
        this.tellerConfig = this.config.integrations[IntegrationId.Teller] as TellerConfig
        this.client = client || new TellerClient(this.tellerConfig)
    }

    public tellerApi = (token: string, route: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: string) =>
        this.client.requestJson(token, route, method, body)

    private tokenFor(account: TellerAccountConfig): string {
        const token = this.config.enrollments?.[account.enrollmentId]?.token
        if (!token) throw new TellerError('configuration', 'Teller enrollment token is missing for this account.')
        return token
    }

    public fetchPagedTransactions = async (
        accountConfig: AccountConfig,
        startDate: Date,
        endDate: Date,
        options: { incremental?: boolean } = {}
    ): Promise<TellerTransaction[]> => {
        const tellerAccount = accountConfig as TellerAccountConfig
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate > endDate) {
            throw new TellerError('request', 'Teller transaction date range is invalid.')
        }
        const start = format(options.incremental ? subDays(startDate, 10) : startDate, 'yyyy-MM-dd')
        const end = format(endDate, 'yyyy-MM-dd')
        const base = `accounts/${encodeURIComponent(tellerAccount.id)}/transactions`
        const results = new Map<string, TellerTransaction>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
            const query = new URLSearchParams({ start_date: start, end_date: end, count: String(PAGE_SIZE) })
            if (cursor) query.set('from_id', cursor)
            const page = parseTellerTransactions(
                await this.tellerApi(this.tokenFor(tellerAccount), `${base}?${query}`),
                tellerAccount.id
            )
            if (page.length > PAGE_SIZE) {
                throw new TellerError('malformed_response', 'Teller transaction page exceeded the requested count.')
            }
            for (const transaction of page) {
                if (transaction.date >= start && transaction.date <= end) results.set(transaction.id, transaction)
            }
            if (page.length < PAGE_SIZE) {
                logInfo(`Received ${results.size} Teller transactions within the requested date range.`)
                return [...results.values()]
            }
            const next = page[page.length - 1].id
            if (cursors.has(next)) {
                throw new TellerError('malformed_response', 'Teller repeated a transaction page cursor.')
            }
            cursors.add(next)
            cursor = next
        }
        throw new TellerError('malformed_response', 'Teller transaction pagination exceeded the page limit.')
    }

    public fetchAccount = async (accountConfig: AccountConfig, startDate: Date, endDate: Date): Promise<Account[]> => {
        const tellerAccount = accountConfig as TellerAccountConfig
        if (startDate < subMonths(new Date(), 5)) {
            logWarn('Transaction history older than 6 months may not be available for some institutions.')
        }
        const base = `accounts/${encodeURIComponent(tellerAccount.id)}`
        const details = parseTellerAccount(await this.tellerApi(this.tokenFor(tellerAccount), base), tellerAccount.id)
        if (!details.links.transactions) {
            throw new TellerError('unsupported_resource', 'Teller transactions are unavailable for this account.')
        }
        const balances = details.links.balances
            ? parseTellerBalances(
                  await this.tellerApi(this.tokenFor(tellerAccount), `${base}/balances`),
                  tellerAccount.id
              )
            : undefined
        const account = normalizeTellerAccount(details, balances)
        const transactions = await this.fetchPagedTransactions(accountConfig, startDate, endDate)
        account.transactions = transactions.map(transaction =>
            normalizeTellerTransaction(transaction, account, details.type === 'credit')
        )
        logInfo(`Fetched Teller account with ${account.transactions.length} transactions.`)
        return [account]
    }
}
