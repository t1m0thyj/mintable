import { BaseIntegrationConfig, IntegrationId, IntegrationType } from '../integrations'

export interface TellerConfig extends BaseIntegrationConfig {
    id: IntegrationId.Teller
    type: IntegrationType.Import

    pathCertificate: string
    pathPrivateKey: string
    appId: string
    environment?: 'sandbox' | 'development' | 'production'
}

export const defaultTellerConfig: TellerConfig = {
    name: '',
    id: IntegrationId.Teller,
    type: IntegrationType.Import,

    pathCertificate: '',
    pathPrivateKey: '',
    appId: ''
}

export interface TellerTransaction {
    account_id: string
    amount: string
    date: string
    description: string
    details?: TellerTransactionDetails | null
    status: 'posted' | 'pending'
    id: string
    links?: TellerTransactionLinks
    running_balance?: string | null
    type: string
}

export interface TellerTransactionDetails {
    category?: string | null
    counterparty?: { name?: string | null; type?: string | null } | null
    processing_status?: 'pending' | 'complete'
}

export interface TellerTransactionLinks {
    account: string
    self: string
}

export interface TellerAccount {
    id: string
    enrollment_id?: string
    name: string
    type: 'depository' | 'credit'
    subtype?: string
    currency: string
    last_four?: string
    status?: 'open' | 'closed'
    institution?: { id?: string; name?: string }
    links: { self?: string; balances?: string; transactions?: string; details?: string }
}

export interface TellerBalances {
    account_id?: string
    ledger?: string | null
    available?: string | null
}
