import { google, sheets_v4 } from 'googleapis'
import { OAuth2Client, Credentials, CodeChallengeMethod } from 'google-auth-library'
import { Config, updateConfig } from '../../common/config'
import { IntegrationId } from '../../types/integrations'
import { GoogleConfig, GoogleCredentials } from '../../types/integrations/google'
import { Account } from '../../types/account'
import { Transaction } from '../../types/transaction'
import { eachMonthOfInterval, endOfMonth, format, isValid, parseISO, startOfMonth, subMonths } from 'date-fns'
import { KEY_COLUMN, KeyedRow, planKeyedSheet } from './sheetPlan'

function quoteSheet(title: string): string {
    return `'${title.replace(/'/g, "''")}'`
}

function reconnectError(error: unknown): Error {
    const responseCode = (error as { response?: { data?: { error?: string } } })?.response?.data?.error || ''
    const detail = `${error instanceof Error ? error.message : ''} ${responseCode}`
    if (/invalid_grant|invalid_token|unauthorized|refresh token/i.test(detail)) {
        return new Error('Google authorization expired or was revoked. Run `mintable google-setup` to reconnect.')
    }
    return new Error('Google Sheets request failed. Verify access to the destination spreadsheet and retry.')
}

function transactionKey(transaction: Transaction): string {
    if (!transaction.integration || !transaction.accountId || !transaction.transactionId) {
        throw new Error(
            'Google export requires a stable integration, account ID, and transaction ID for every transaction.'
        )
    }
    return JSON.stringify([transaction.integration, transaction.accountId, transaction.transactionId])
}

function accountKey(account: Account): string {
    if (!account.integration || !(account.accountId || account.account)) {
        throw new Error('Google export requires a stable account ID for every balance.')
    }
    return JSON.stringify([account.integration, account.accountId || account.account])
}

interface SheetWork {
    title: string
    columns: string[]
    rows: KeyedRow[]
    complete: boolean
    canRetire?: (key: string) => boolean
}

export function mergeGoogleCredentials(existing: GoogleCredentials, tokens: Credentials): GoogleCredentials {
    return {
        ...existing,
        accessToken: tokens.access_token || existing.accessToken,
        refreshToken: tokens.refresh_token || existing.refreshToken,
        tokenType: tokens.token_type || existing.tokenType,
        expiryDate: tokens.expiry_date || existing.expiryDate
    }
}

export class GoogleIntegration {
    config: Config
    googleConfig: GoogleConfig
    client: OAuth2Client
    sheets: sheets_v4.Resource$Spreadsheets

    constructor(config: Config, sheets?: sheets_v4.Resource$Spreadsheets, persistTokens = true) {
        this.config = config
        this.googleConfig = config.integrations[IntegrationId.Google] as GoogleConfig
        if (!this.googleConfig?.documentId) throw new Error('Google destination spreadsheet is not configured.')
        this.client = new google.auth.OAuth2(
            this.googleConfig.credentials.clientId,
            this.googleConfig.credentials.clientSecret
        )
        this.client.setCredentials({
            access_token: this.googleConfig.credentials.accessToken,
            refresh_token: this.googleConfig.credentials.refreshToken,
            token_type: this.googleConfig.credentials.tokenType,
            expiry_date: this.googleConfig.credentials.expiryDate
        })
        if (persistTokens) this.client.on('tokens', tokens => this.saveAccessTokens(tokens))
        this.sheets = sheets || google.sheets({ version: 'v4', auth: this.client }).spreadsheets
    }

    public authorizationUrl(redirectUri: string, state: string, codeChallenge: string): string {
        return this.client.generateAuthUrl({
            redirect_uri: redirectUri,
            scope: this.googleConfig.credentials.scope || ['https://www.googleapis.com/auth/spreadsheets'],
            access_type: 'offline',
            prompt: 'consent',
            state,
            code_challenge: codeChallenge,
            code_challenge_method: CodeChallengeMethod.S256
        })
    }

    public async getAccessTokens(code: string, codeVerifier: string, redirectUri: string): Promise<Credentials> {
        const response = await this.client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
        return response.tokens
    }

    public saveAccessTokens(tokens: Credentials): void {
        updateConfig(config => {
            const googleConfig = config.integrations[IntegrationId.Google] as GoogleConfig
            googleConfig.credentials = mergeGoogleCredentials(googleConfig.credentials, tokens)
            return config
        })
        this.client.setCredentials({
            ...this.client.credentials,
            ...tokens,
            refresh_token: tokens.refresh_token || this.client.credentials.refresh_token
        })
    }

    private value(row: Record<string, unknown>, column: string, transaction: boolean): unknown {
        const raw = row[column]
        if (column === 'date' && raw instanceof Date) {
            if (!isValid(raw)) throw new Error('Cannot export a transaction with an invalid date.')
            const source = transaction && typeof row.dateOnly === 'string' ? parseISO(row.dateOnly) : raw
            if (!isValid(source)) throw new Error('Cannot export a transaction with an invalid bank date.')
            return format(source, this.googleConfig.transactionDateFormat || 'yyyy-MM-dd')
        }
        return raw ?? ''
    }

    private work(
        accounts: Account[],
        startDate: Date,
        endDate: Date,
        balances: boolean,
        transactions: boolean
    ): SheetWork[] {
        const result: SheetWork[] = []
        if (balances) {
            const columns = this.config.balances.properties
            result.push({
                title: 'Balances',
                columns,
                rows: accounts.map(account => ({
                    key: accountKey(account),
                    values: columns.map(column =>
                        this.value(account as unknown as Record<string, unknown>, column, false)
                    )
                })),
                complete: true
            })
        }
        if (transactions) {
            const columns = this.config.transactions.properties
            const all = accounts.flatMap(account => account.transactions || [])
            const hasTeller = accounts.some(account => account.integration === IntegrationId.Teller)
            const oldestTellerMonth = startOfMonth(subMonths(new Date(), 5))
            const fetchedAccounts = new Set(accounts.map(account => accountKey(account)))
            const byMonth = new Map<string, KeyedRow[]>()
            for (const transaction of all) {
                if (!(transaction.date instanceof Date) || !isValid(transaction.date)) {
                    throw new Error('Cannot export a transaction with an invalid date.')
                }
                const month = transaction.dateOnly?.slice(0, 7) || format(transaction.date, 'yyyy-MM')
                const values = columns.map(column =>
                    this.value(transaction as unknown as Record<string, unknown>, column, true)
                )
                const rows = byMonth.get(month) || []
                rows.push({ key: transactionKey(transaction), values })
                byMonth.set(month, rows)
            }
            const titles = new Set<string>()
            for (const monthDate of eachMonthOfInterval({ start: startDate, end: endDate })) {
                const month = format(monthDate, 'yyyy-MM')
                const title = format(
                    monthDate,
                    this.googleConfig.monthTabFormat || this.googleConfig.dateFormat || 'yyyy.MM'
                )
                if (title === 'Balances' || titles.has(title))
                    throw new Error('Google month-tab format produces duplicate or reserved titles.')
                titles.add(title)
                result.push({
                    title,
                    columns,
                    rows: byMonth.get(month) || [],
                    canRetire: key => {
                        try {
                            const [integration, accountId] = JSON.parse(key)
                            return fetchedAccounts.has(JSON.stringify([integration, accountId]))
                        } catch (_) {
                            return false
                        }
                    },
                    complete:
                        format(startDate, 'yyyy-MM-dd') <= format(startOfMonth(monthDate), 'yyyy-MM-dd') &&
                        format(endDate, 'yyyy-MM-dd') >= format(endOfMonth(monthDate), 'yyyy-MM-dd') &&
                        (!hasTeller || monthDate >= oldestTellerMonth)
                })
            }
        }
        return result
    }

    public async updateAll(
        accounts: Account[],
        startDate: Date,
        endDate: Date,
        balances = true,
        transactions = true
    ): Promise<void> {
        const work = this.work(accounts, startDate, endDate, balances, transactions)
        const spreadsheetId = this.googleConfig.documentId
        if (!this.googleConfig.credentials.refreshToken) {
            throw new Error('Google offline authorization is missing. Run `mintable google-setup` to connect.')
        }
        try {
            const metadata = await this.sheets.get({
                spreadsheetId,
                fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'
            })
            const existing = new Map(
                (metadata.data.sheets || []).map(sheet => [sheet.properties.title, sheet.properties])
            )
            let nextId = Math.max(0, ...[...existing.values()].map(properties => properties.sheetId || 0)) + 1
            const requests: sheets_v4.Schema$Request[] = []
            for (const item of work) {
                let properties = existing.get(item.title)
                let values: unknown[][] = []
                if (properties) {
                    const response = await this.sheets.values.get({
                        spreadsheetId,
                        range: quoteSheet(item.title),
                        valueRenderOption: 'FORMULA'
                    })
                    values = response.data.values || []
                } else if (item.rows.length === 0 && item.title !== 'Balances') {
                    continue
                } else {
                    const sheetId = nextId++
                    const template = item.title === 'Balances' ? undefined : this.googleConfig.template
                    if (template) {
                        if (template.documentId !== spreadsheetId) {
                            throw new Error(
                                'Cross-spreadsheet Google templates cannot be copied in the atomic export. Precreate a keyed monthly sheet in the destination or remove the template setting.'
                            )
                        }
                        const source = existing.get(template.sheetTitle)
                        if (!source) throw new Error(`Google template sheet ${template.sheetTitle} was not found.`)
                        const response = await this.sheets.values.get({
                            spreadsheetId,
                            range: quoteSheet(template.sheetTitle),
                            valueRenderOption: 'FORMULA'
                        })
                        values = response.data.values || []
                        requests.push({
                            duplicateSheet: {
                                sourceSheetId: source.sheetId,
                                newSheetId: sheetId,
                                newSheetName: item.title
                            }
                        })
                        properties = { ...source, sheetId, title: item.title }
                    } else {
                        requests.push({
                            addSheet: {
                                properties: {
                                    sheetId,
                                    title: item.title,
                                    gridProperties: {
                                        rowCount: 1000,
                                        columnCount: Math.max(26, item.columns.length + 1),
                                        frozenRowCount: 1
                                    }
                                }
                            }
                        })
                        properties = {
                            sheetId,
                            title: item.title,
                            gridProperties: { rowCount: 1000, columnCount: Math.max(26, item.columns.length + 1) }
                        }
                    }
                }
                if ((properties.gridProperties?.columnCount || 0) < item.columns.length + 1) {
                    requests.push({
                        appendDimension: {
                            sheetId: properties.sheetId,
                            dimension: 'COLUMNS',
                            length: item.columns.length + 1 - (properties.gridProperties?.columnCount || 0)
                        }
                    })
                }
                requests.push(
                    ...planKeyedSheet(
                        item.title,
                        properties.sheetId,
                        properties.gridProperties?.rowCount || 1000,
                        values,
                        item.columns,
                        item.rows,
                        item.complete,
                        item.canRetire
                    )
                )
            }
            if (requests.length) await this.sheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
        } catch (error) {
            if (
                error instanceof Error &&
                /older or different column layout|unkeyed generated rows|duplicate transaction keys|invalid or duplicate generated key|template|managed columns|stable account ID|stable integration/.test(
                    error.message
                )
            )
                throw error
            throw reconnectError(error)
        }
    }

    public updateTransactions(accounts: Account[], startDate: Date, endDate: Date): Promise<void> {
        return this.updateAll(accounts, startDate, endDate, false, true)
    }

    public updateBalances(accounts: Account[]): Promise<void> {
        return this.updateAll(accounts, new Date(), new Date(), true, false)
    }
}
