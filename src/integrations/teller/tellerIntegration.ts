import path from 'path'
import { format, subDays, subMonths } from 'date-fns'
import { Config, updateConfig } from '../../common/config'
import { TellerConfig, TellerTransaction } from '../../types/integrations/teller'
import { IntegrationId } from '../../types/integrations'
import express from 'express'
import bodyParser from 'body-parser'
import { logInfo, logWarn } from '../../common/logging'
import http from 'http'
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

    public registerAccount = (accessToken: string, accountId: string): void => {
        updateConfig(config => {
            config.accounts[accountId] = {
                id: accountId,
                integration: IntegrationId.Teller,
                token: accessToken
            }
            this.config = config
            return config
        })
    }

    public accountSetup = (): Promise<void> => {
        return new Promise((resolve, reject) => {
            const app = express()
                .use(bodyParser.json())
                .use(bodyParser.urlencoded({ extended: true }))
                .use(express.static(path.resolve(path.join(__dirname, '../../../docs'))))

            let server: http.Server

            app.post('/get_enrollment_accounts', async (req, res) => {
                const token = req.body?.enrollment?.accessToken
                if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'Invalid enrollment.' })
                try {
                    const accounts = await this.tellerApi(token, 'accounts')
                    return res.json(accounts)
                } catch {
                    return res.status(502).json({ error: 'Unable to load Teller accounts.' })
                }
            })

            app.post('/register_account', (req, res) => {
                if (typeof req.body?.accessToken !== 'string' || typeof req.body?.accountId !== 'string') {
                    return res.status(400).json({ error: 'Invalid account selection.' })
                }
                try {
                    this.registerAccount(req.body.accessToken, req.body.accountId)
                    logInfo('Teller account saved.')
                    return res.json({})
                } catch {
                    return res.status(500).json({ error: 'Unable to save Teller account.' })
                }
            })

            app.post('/accounts', async (_req, res) => {
                const accounts: { id: string; name: string }[] = []
                try {
                    for (const accountId in this.config.accounts) {
                        const accountConfig = this.config.accounts[accountId] as TellerAccountConfig
                        if (accountConfig.integration !== IntegrationId.Teller) continue
                        const raw = await this.tellerApi(
                            accountConfig.token,
                            `accounts/${encodeURIComponent(accountConfig.id)}`
                        )
                        const info = parseTellerAccount(raw, accountConfig.id)
                        accounts.push({
                            id: info.id,
                            name: [info.institution?.name, info.name, info.last_four].filter(Boolean).join(' ')
                        })
                    }
                    return res.json(accounts)
                } catch {
                    return res.status(502).json({ error: 'Unable to load saved Teller accounts.' })
                }
            })

            app.post('/remove', (req, res) => {
                try {
                    updateConfig(config => {
                        if (config.accounts[req.body.accountId]) delete config.accounts[req.body.accountId]
                        this.config = config
                        return config
                    })
                    logInfo('Successfully removed Teller account.')
                    return res.json({})
                } catch {
                    return res.status(500).json({ error: 'Unable to remove Teller account.' })
                }
            })

            app.post('/done', (_req, res) => {
                res.json({})
                server.close()
                resolve()
            })

            app.get('/', (_req, res) =>
                res.sendFile(path.resolve(path.join(__dirname, '../../../src/integrations/teller/account-setup.html')))
            )

            server = http.createServer(app)
            server.on('error', reject)
            server.listen(8000, '127.0.0.1')
        })
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
                await this.tellerApi(tellerAccount.token, `${base}?${query}`),
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
        const details = parseTellerAccount(await this.tellerApi(tellerAccount.token, base), tellerAccount.id)
        if (!details.links.transactions) {
            throw new TellerError('unsupported_resource', 'Teller transactions are unavailable for this account.')
        }
        const balances = details.links.balances
            ? parseTellerBalances(await this.tellerApi(tellerAccount.token, `${base}/balances`), tellerAccount.id)
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
