import { Account } from '../../types/account'
import { IntegrationId } from '../../types/integrations'
import { TellerAccount, TellerBalances, TellerTransaction } from '../../types/integrations/teller'
import { Transaction } from '../../types/transaction'
import { TellerError } from './tellerClient'

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const malformed = (resource: string): never => {
    throw new TellerError('malformed_response', `Teller returned invalid ${resource} data.`)
}

export const parseMoney = (value: unknown, resource: string): number => {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return malformed(resource)
    const amount = Number(value)
    if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) return malformed(resource)
    return amount === 0 ? 0 : amount
}

export const parseBankDate = (value: unknown): Date => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return malformed('transaction date')
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return malformed('transaction date')
    }
    return date
}

export const parseTellerAccount = (raw: unknown, expectedId: string): TellerAccount => {
    if (!isRecord(raw) || raw.id !== expectedId || !nonempty(raw.name) || !nonempty(raw.currency)) {
        return malformed('account')
    }
    if (raw.type !== 'credit' && raw.type !== 'depository') return malformed('account type')
    if (!isRecord(raw.links)) return malformed('account capabilities')
    for (const key of ['enrollment_id', 'subtype', 'last_four']) {
        if (raw[key] !== undefined && typeof raw[key] !== 'string') return malformed('account')
    }
    if (raw.status === 'closed') {
        throw new TellerError('closed_account', 'Teller account is closed or no longer accessible.')
    }
    if (raw.status !== undefined && raw.status !== 'open') return malformed('account status')
    if (raw.institution !== undefined && (!isRecord(raw.institution) || !nonempty(raw.institution.name))) {
        return malformed('institution')
    }
    for (const capability of ['balances', 'transactions']) {
        if (raw.links[capability] !== undefined && typeof raw.links[capability] !== 'string') {
            return malformed('account capabilities')
        }
    }
    return raw as unknown as TellerAccount
}

export const parseTellerBalances = (raw: unknown, accountId: string): TellerBalances => {
    if (!isRecord(raw) || (raw.account_id !== undefined && raw.account_id !== accountId)) return malformed('balances')
    for (const key of ['ledger', 'available']) {
        if (raw[key] !== undefined && raw[key] !== null) parseMoney(raw[key], `balance ${key}`)
    }
    return raw as TellerBalances
}

export const parseTellerTransactions = (raw: unknown, accountId: string): TellerTransaction[] => {
    if (!Array.isArray(raw)) return malformed('transactions')
    return raw.map(item => {
        if (
            !isRecord(item) ||
            !nonempty(item.id) ||
            item.account_id !== accountId ||
            typeof item.description !== 'string' ||
            !nonempty(item.type) ||
            (item.status !== 'posted' && item.status !== 'pending')
        ) {
            return malformed('transaction')
        }
        parseBankDate(item.date)
        parseMoney(item.amount, 'transaction amount')
        if (item.running_balance !== undefined && item.running_balance !== null) {
            parseMoney(item.running_balance, 'running balance')
        }
        if (item.links !== undefined && !isRecord(item.links)) return malformed('transaction links')
        if (item.details !== undefined && item.details !== null) {
            if (!isRecord(item.details)) return malformed('transaction details')
            if (
                item.details.processing_status !== undefined &&
                item.details.processing_status !== 'pending' &&
                item.details.processing_status !== 'complete'
            ) {
                return malformed('transaction processing status')
            }
            if (
                item.details.category !== undefined &&
                item.details.category !== null &&
                typeof item.details.category !== 'string'
            ) {
                return malformed('transaction category')
            }
            if (item.details.counterparty !== undefined && item.details.counterparty !== null) {
                if (!isRecord(item.details.counterparty)) return malformed('transaction counterparty')
                for (const key of ['name', 'type']) {
                    const value = item.details.counterparty[key]
                    if (value !== undefined && value !== null && typeof value !== 'string') {
                        return malformed('transaction counterparty')
                    }
                }
            }
        }
        return item as unknown as TellerTransaction
    })
}

export const normalizeTellerAccount = (details: TellerAccount, balances?: TellerBalances): Account => {
    const account: Account = {
        integration: IntegrationId.Teller,
        accountId: details.id,
        institution: details.institution?.name,
        account: details.name,
        mask: details.last_four,
        type: details.subtype || details.type,
        currency: details.currency
    }
    if (balances?.ledger !== undefined && balances?.ledger !== null) {
        account.current = parseMoney(balances.ledger, 'ledger balance')
    }
    if (balances?.available !== undefined && balances?.available !== null) {
        account.available = parseMoney(balances.available, 'available balance')
    }
    return account
}

export const normalizeTellerTransaction = (
    source: TellerTransaction,
    account: Account,
    isCredit: boolean
): Transaction => {
    const parsedAmount = parseMoney(source.amount, 'transaction amount')
    const label = [account.institution, account.account, account.mask].filter(Boolean).join(' ')
    const amountDecimal =
        parsedAmount === 0
            ? source.amount.replace(/^-/, '')
            : isCredit
              ? source.amount
              : source.amount.startsWith('-')
                ? source.amount.slice(1)
                : `-${source.amount}`
    return {
        integration: IntegrationId.Teller,
        transactionId: source.id,
        accountId: source.account_id,
        name: source.description,
        date: parseBankDate(source.date),
        dateOnly: source.date,
        amount: parsedAmount === 0 ? 0 : isCredit ? parsedAmount : -parsedAmount,
        amountDecimal,
        currency: account.currency,
        type: source.type,
        institution: account.institution,
        account: label,
        category: source.details?.category || undefined,
        counterparty: source.details?.counterparty?.name || undefined,
        counterpartyType: source.details?.counterparty?.type || undefined,
        pending: source.status === 'pending'
    }
}
