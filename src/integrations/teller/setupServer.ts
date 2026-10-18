import path from 'path'
import http from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import express from 'express'
import { Config, updateConfig } from '../../common/config'
import { IntegrationId } from '../../types/integrations'
import { TellerConfig, TellerAccount } from '../../types/integrations/teller'
import { TellerAccountConfig } from '../../types/account'
import { parseTellerAccounts } from './tellerNormalizer'
import { TellerClient } from './tellerClient'

type RequestJson = Pick<TellerClient, 'requestJson'>
type SaveConfig = (change: (config: Config) => Config) => Config

export interface SetupServerOptions {
    port?: number
    save?: SaveConfig
    client?: RequestJson
}

export interface SetupServer {
    url: string
    done: Promise<void>
    close: () => Promise<void>
}

const validId = (value: unknown, prefix: string): value is string =>
    typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`).test(value)

export async function startTellerSetupServer(config: Config, options: SetupServerOptions = {}): Promise<SetupServer> {
    const teller = config.integrations[IntegrationId.Teller] as TellerConfig
    if (!teller?.appId || !teller.environment) throw new Error('Configure Teller before linking accounts.')
    const client = options.client || new TellerClient(teller)
    const save = options.save || ((change: (config: Config) => Config) => updateConfig(change))
    const credential = randomBytes(32).toString('base64url')
    const app = express().disable('x-powered-by')
    app.use(express.json({ limit: '16kb' }))
    let origin: string
    let pending: { id: string; token: string; accounts: Map<string, TellerAccount>; institution?: string } | undefined
    let completed = false
    let resolveDone: () => void
    let rejectDone: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
    })
    // A cancelled setup is a normal control path; callers still receive the rejection.
    done.catch(() => undefined)
    const server = http.createServer(app)
    const close = (): Promise<void> =>
        new Promise(resolve => {
            if (!server.listening) return resolve()
            server.close(() => resolve())
        })
    const cancel = (error: Error): void => {
        if (completed) return
        completed = true
        rejectDone(error)
        void close()
    }

    app.use((req, res, next) => {
        if (req.headers.host !== new URL(origin).host) return res.sendStatus(403)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Referrer-Policy', 'no-referrer')
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
        if (req.method !== 'GET') {
            if (req.headers.origin !== origin) return res.sendStatus(403)
            const supplied = req.get('x-mintable-session') || ''
            const a = Buffer.from(supplied)
            const b = Buffer.from(credential)
            if (a.length !== b.length || !timingSafeEqual(a, b)) return res.sendStatus(403)
        }
        next()
    })

    app.get('/', (_req, res) =>
        res.sendFile(path.resolve(__dirname, '../../../src/integrations/teller/account-setup.html'))
    )
    app.get('/account-setup.js', (_req, res) =>
        res.sendFile(path.resolve(__dirname, '../../../src/integrations/teller/account-setup.js'))
    )
    app.get('/css/account-setup.css', (_req, res) =>
        res.sendFile(path.resolve(__dirname, '../../../docs/css/account-setup.css'))
    )
    app.get('/img/icon.png', (_req, res) => res.sendFile(path.resolve(__dirname, '../../../docs/img/icon.png')))
    app.post('/setup', (_req, res) =>
        res.json({
            applicationId: teller.appId,
            environment: teller.environment,
            enrollments: Object.values(config.enrollments).map(({ id, institution }) => ({ id, institution }))
        })
    )
    app.post('/accounts', (_req, res) =>
        res.json(
            Object.values(config.accounts)
                .filter((account): account is TellerAccountConfig => account.integration === IntegrationId.Teller)
                .map(({ id, label, enrollmentId }) => ({ id, label, enrollmentId }))
        )
    )
    app.post('/enrollment', async (req, res) => {
        const id = req.body?.enrollment?.id
        const token = req.body?.accessToken
        if (!validId(id, 'enr') || typeof token !== 'string' || !/^(?:test_)?token_[A-Za-z0-9_-]{1,256}$/.test(token)) {
            return res.status(400).json({ error: 'Invalid Teller enrollment.' })
        }
        try {
            const raw = await client.requestJson(token, 'accounts')
            const accounts = parseTellerAccounts(raw)
            if (accounts.some(account => account.enrollment_id !== id)) {
                return res.status(400).json({ error: 'Accounts do not belong to this enrollment.' })
            }
            const institution =
                typeof req.body.enrollment.institution?.name === 'string'
                    ? req.body.enrollment.institution.name.slice(0, 128)
                    : undefined
            pending = { id, token, accounts: new Map(accounts.map(account => [account.id, account])), institution }
            if (config.enrollments[id]) {
                config = save(current => {
                    current.enrollments[id] = { id, token, institution }
                    return current
                })
            }
            return res.json(
                accounts.map(account => ({
                    id: account.id,
                    label: [account.institution?.name, account.name, account.last_four].filter(Boolean).join(' ')
                }))
            )
        } catch {
            return res.status(502).json({ error: 'Unable to load Teller accounts.' })
        }
    })
    app.post('/register', (req, res) => {
        const id = req.body?.accountId
        if (!validId(id, 'acc') || !pending?.accounts.has(id)) {
            return res.status(400).json({ error: 'Account is not in the active enrollment.' })
        }
        const account = pending.accounts.get(id)
        const label = [account.institution?.name, account.name, account.last_four]
            .filter(Boolean)
            .join(' ')
            .slice(0, 256)
        try {
            config = save(current => {
                if (current.accounts[id] && current.accounts[id].integration !== IntegrationId.Teller) {
                    throw new Error('Account ID already exists.')
                }
                if (
                    current.accounts[id]?.integration === IntegrationId.Teller &&
                    (current.accounts[id] as TellerAccountConfig).enrollmentId !== pending.id
                ) {
                    throw new Error('Account is linked to another enrollment.')
                }
                current.enrollments[pending.id] = {
                    id: pending.id,
                    token: pending.token,
                    institution: pending.institution
                }
                current.accounts[id] = { id, integration: IntegrationId.Teller, enrollmentId: pending.id, label }
                return current
            })
            return res.json({})
        } catch {
            return res.status(500).json({ error: 'Unable to save account.' })
        }
    })
    app.post('/remove', (req, res) => {
        const id = req.body?.accountId
        if (!validId(id, 'acc') || config.accounts[id]?.integration !== IntegrationId.Teller) {
            return res.status(404).json({ error: 'Teller account not found.' })
        }
        try {
            config = save(current => {
                const enrollmentId = (current.accounts[id] as TellerAccountConfig).enrollmentId
                delete current.accounts[id]
                if (
                    !Object.values(current.accounts).some(
                        account =>
                            account.integration === IntegrationId.Teller &&
                            (account as TellerAccountConfig).enrollmentId === enrollmentId
                    )
                )
                    delete current.enrollments[enrollmentId]
                return current
            })
            return res.json({})
        } catch {
            return res.status(500).json({ error: 'Unable to remove account.' })
        }
    })
    app.post('/done', (_req, res) => {
        res.json({})
        completed = true
        void close().then(resolveDone)
    })
    app.post('/cancel', (_req, res) => {
        res.json({})
        cancel(new Error('Account setup cancelled.'))
    })

    const requestedPort = options.port ?? 0
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        throw new Error('Invalid account setup port.')
    }
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(requestedPort, '127.0.0.1', () => {
                server.off('error', reject)
                resolve()
            })
        })
    } catch (error) {
        cancel(error as Error)
        throw error
    }
    const address = server.address()
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : requestedPort}`
    return {
        url: `${origin}/#${credential}`,
        done,
        close: async () => {
            cancel(new Error('Account setup cancelled.'))
            await close()
        }
    }
}
