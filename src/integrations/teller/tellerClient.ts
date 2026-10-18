import { createPrivateKey, X509Certificate } from 'crypto'
import { readFileSync } from 'fs'
import https, { Agent, RequestOptions } from 'https'
import { ClientRequest, IncomingMessage } from 'http'
import { createSecureContext } from 'tls'
import { TellerConfig } from '../../types/integrations/teller'

export const TELLER_API_ORIGIN = 'https://api.teller.io'
export const TELLER_API_VERSION = '2020-10-12'

export type TellerErrorKind =
    | 'configuration'
    | 'credentials'
    | 'disconnected'
    | 'closed_account'
    | 'unsupported_resource'
    | 'temporary'
    | 'timeout'
    | 'network'
    | 'malformed_response'
    | 'request'

export class TellerError extends Error {
    constructor(
        readonly kind: TellerErrorKind,
        message: string,
        readonly status?: number,
        readonly providerCode?: string,
        readonly retryable = false,
        readonly retryAfterMs?: number
    ) {
        super(message)
        this.name = 'TellerError'
    }
}

export type TellerRequest = (
    url: URL,
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void
) => ClientRequest

export interface TellerClientOptions {
    request?: TellerRequest
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
    maxAttempts?: number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const readCredentials = (config: TellerConfig): { cert?: Buffer; key?: Buffer } => {
    const certPath = process.env.TELLER_CERTIFICATE_FILE || config.pathCertificate
    const keyPath = process.env.TELLER_PRIVATE_KEY_FILE || config.pathPrivateKey
    if (!certPath && !keyPath && config.environment === 'sandbox') return {}
    if (!certPath || !keyPath) {
        throw new TellerError('configuration', 'Teller requires both a client certificate file and private key file.')
    }
    try {
        const cert = readFileSync(certPath)
        const key = readFileSync(keyPath)
        const certificate = new X509Certificate(cert)
        const privateKey = createPrivateKey(key)
        if (
            !certificate.checkPrivateKey(privateKey) ||
            Date.parse(certificate.validFrom) > Date.now() ||
            Date.parse(certificate.validTo) < Date.now()
        ) {
            throw new Error('Invalid certificate and key pair')
        }
        createSecureContext({ cert, key })
        return { cert, key }
    } catch {
        throw new TellerError(
            'configuration',
            'Teller client certificate or private key file is missing or invalid. Check pathCertificate/pathPrivateKey or TELLER_CERTIFICATE_FILE/TELLER_PRIVATE_KEY_FILE.'
        )
    }
}

const classifyHttpError = (status: number, payload: unknown, retryAfter: string | string[]): TellerError => {
    const error =
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        payload.error &&
        typeof payload.error === 'object'
            ? payload.error
            : undefined
    const rawCode = error && 'code' in error ? error.code : undefined
    const code = typeof rawCode === 'string' && /^[a-z0-9._-]{1,120}$/i.test(rawCode) ? rawCode : undefined
    const retryAfterSeconds = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter)
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(Math.max(retryAfterSeconds * 1000, 0), 2000)
        : undefined
    if (code?.startsWith('enrollment.disconnected')) {
        return new TellerError('disconnected', 'Teller enrollment needs to be reconnected.', status, code)
    }
    if (status === 410 || code?.startsWith('account.closed')) {
        return new TellerError('closed_account', 'Teller account is closed or no longer accessible.', status, code)
    }
    if (status === 400 || status === 401 || status === 403) {
        return new TellerError('credentials', 'Teller certificate or access token was rejected.', status, code)
    }
    if (status === 404) {
        return new TellerError('unsupported_resource', 'Teller resource is unavailable for this account.', status, code)
    }
    if (status === 429 || status >= 500) {
        return new TellerError(
            'temporary',
            `Teller temporarily unavailable (HTTP ${status}).`,
            status,
            code,
            true,
            retryAfterMs
        )
    }
    return new TellerError('request', `Teller rejected the request (HTTP ${status}).`, status, code)
}

const classifyNetworkError = (error: NodeJS.ErrnoException): TellerError => {
    if (error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR') {
        return new TellerError('timeout', 'Teller request timed out.', undefined, undefined, true)
    }
    const retryable = ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE'].includes(error.code || '')
    return new TellerError('network', 'Teller network request failed.', undefined, undefined, retryable)
}

export class TellerClient {
    readonly agent: Agent
    private readonly request: TellerRequest
    private readonly sleep: (ms: number) => Promise<void>
    private readonly timeoutMs: number
    private readonly maxAttempts: number

    constructor(config: TellerConfig, options: TellerClientOptions = {}) {
        this.agent = new https.Agent({ keepAlive: true, maxSockets: 5, ...readCredentials(config) })
        this.request = options.request || https.request
        this.sleep = options.sleep || sleep
        this.timeoutMs = options.timeoutMs ?? 15000
        this.maxAttempts = options.maxAttempts ?? 3
        if (this.timeoutMs <= 0 || this.maxAttempts < 1) {
            throw new TellerError('configuration', 'Teller timeout and retry settings must be positive.')
        }
    }

    async requestJson(
        token: string,
        route: string,
        method: 'GET' | 'POST' | 'DELETE' = 'GET',
        body?: string
    ): Promise<unknown> {
        if (!token) throw new TellerError('credentials', 'Teller access token is missing.')
        const url = new URL(route, `${TELLER_API_ORIGIN}/`)
        if (url.origin !== TELLER_API_ORIGIN || url.username || url.password) {
            throw new TellerError('request', 'Teller request must use the Teller API origin.')
        }
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.requestOnce(url, token, method, body)
            } catch (error) {
                const failure =
                    error instanceof TellerError ? error : classifyNetworkError(error as NodeJS.ErrnoException)
                if (!failure.retryable || method !== 'GET' || attempt >= this.maxAttempts) throw failure
                await this.sleep(failure.retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1), 2000))
            }
        }
    }

    private requestOnce(url: URL, token: string, method: string, body?: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            let req: ClientRequest
            try {
                req = this.request(
                    url,
                    {
                        method,
                        agent: this.agent,
                        signal: AbortSignal.timeout(this.timeoutMs),
                        auth: `${token}:`,
                        headers: {
                            Accept: 'application/json',
                            'Teller-Version': TELLER_API_VERSION,
                            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
                        }
                    },
                    response => {
                        const chunks: Buffer[] = []
                        let size = 0
                        response.on('data', (chunk: Buffer) => {
                            size += chunk.length
                            if (size > 20 * 1024 * 1024) {
                                reject(
                                    new TellerError('malformed_response', 'Teller response exceeded the size limit.')
                                )
                                response.destroy()
                            } else {
                                chunks.push(Buffer.from(chunk))
                            }
                        })
                        response.on('error', error => reject(classifyNetworkError(error)))
                        response.on('aborted', () =>
                            reject(
                                new TellerError(
                                    'network',
                                    'Teller response was interrupted.',
                                    undefined,
                                    undefined,
                                    true
                                )
                            )
                        )
                        response.on('end', () => {
                            const status = response.statusCode || 0
                            const raw = Buffer.concat(chunks).toString('utf8')
                            let payload: unknown
                            if (raw) {
                                try {
                                    payload = JSON.parse(raw)
                                } catch {
                                    reject(
                                        status === 429 || status >= 500
                                            ? classifyHttpError(status, undefined, response.headers['retry-after'])
                                            : new TellerError(
                                                  'malformed_response',
                                                  'Teller returned invalid JSON.',
                                                  status
                                              )
                                    )
                                    return
                                }
                            }
                            if (status < 200 || status >= 300) {
                                reject(classifyHttpError(status, payload, response.headers['retry-after']))
                            } else if (!raw && status !== 204) {
                                reject(
                                    new TellerError('malformed_response', 'Teller returned an empty response.', status)
                                )
                            } else {
                                resolve(payload)
                            }
                        })
                    }
                )
            } catch (error) {
                reject(classifyNetworkError(error as NodeJS.ErrnoException))
                return
            }
            req.setTimeout(this.timeoutMs, () => {
                const timeout = new Error('timeout') as NodeJS.ErrnoException
                timeout.code = 'ETIMEDOUT'
                req.destroy(timeout)
            })
            req.on('error', error => reject(classifyNetworkError(error)))
            if (body) req.write(body)
            req.end()
        })
    }
}
