import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { AddressInfo } from 'net'
import { Credentials } from 'google-auth-library'
import { GoogleConfig, defaultGoogleConfig } from '../../types/integrations/google'
import { updateConfig, getConfig } from '../../common/config'
import prompts from 'prompts'
import { IntegrationId } from '../../types/integrations'
import open from 'open'
import { GoogleIntegration } from './googleIntegration'
import { logInfo } from '../../common/logging'

export async function authorizeDesktop(
    google: GoogleIntegration,
    openBrowser: (url: string) => Promise<unknown> = url => open(url, { wait: false })
): Promise<Credentials> {
    const state = randomBytes(32).toString('base64url')
    const { codeVerifier, codeChallenge } = await google.client.generateCodeVerifierAsync()
    return new Promise<Credentials>((resolve, reject) => {
        let settled = false
        let exchanging = false
        const server = createServer(async (request, response) => {
            if (settled || exchanging) {
                response.writeHead(409).end('Authorization is already being completed.')
                return
            }
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.setHeader('Connection', 'close')
            const callback = new URL(request.url || '/', `http://127.0.0.1`)
            if (callback.pathname !== '/oauth2callback') {
                response.writeHead(404).end('Not found')
                return
            }
            if (callback.searchParams.get('state') !== state) {
                response.writeHead(400).end('Authorization state did not match. Return to Mintable and retry.')
                finish(new Error('Google authorization state did not match. Retry `mintable google-setup`.'))
                return
            }
            const code = callback.searchParams.get('code')
            if (!code || callback.searchParams.has('error')) {
                response.writeHead(400).end('Google authorization was cancelled or denied.')
                finish(new Error('Google authorization was cancelled or denied.'))
                return
            }
            try {
                exchanging = true
                const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2callback`
                const tokens = await google.getAccessTokens(code, codeVerifier, redirectUri)
                response.writeHead(200).end('Mintable is connected. You can close this tab and return to the terminal.')
                finish(undefined, tokens)
            } catch (_) {
                response.writeHead(500).end('Google authorization failed. Return to Mintable and retry.')
                finish(new Error('Google authorization code exchange failed. Retry `mintable google-setup`.'))
            }
        })
        const timeout = setTimeout(
            () => finish(new Error('Google authorization timed out. Retry `mintable google-setup`.')),
            300000
        )
        function finish(error?: Error, tokens?: Credentials): void {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            server.close()
            if (error) reject(error)
            else resolve(tokens)
        }
        server.once('error', () =>
            finish(new Error('Cannot start the local Google authorization callback. Check loopback access and retry.'))
        )
        server.listen(0, '127.0.0.1', async () => {
            const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2callback`
            const url = google.authorizationUrl(redirectUri, state, codeChallenge)
            console.log('Opening your browser for Google authorization. Complete sign-in there, then return here.')
            try {
                await openBrowser(url)
            } catch (_) {
                finish(
                    new Error(`Could not open a browser. Open this URL yourself and retry the authorization: ${url}`)
                )
            }
        })
    })
}

export default async (): Promise<void> => {
    console.log('\nGoogle Sheets setup:')
    console.log('1. Create a spreadsheet at https://sheets.new')
    console.log('2. Enable the Sheets API and create a Desktop-app OAuth client in Google Cloud.')
    console.log('3. Configure the OAuth consent screen for your intended users. For unattended runs,')
    console.log('   do not leave an External app in Testing: Sheets refresh tokens expire after seven days.')
    console.log('4. Enter the Desktop client credentials and spreadsheet ID.\n')
    const answers = await prompts([
        { type: 'text', name: 'name', message: 'Integration name', initial: 'Google Sheets' },
        { type: 'password', name: 'clientId', message: 'Desktop client ID' },
        { type: 'password', name: 'clientSecret', message: 'Desktop client secret' },
        { type: 'text', name: 'documentId', message: 'Spreadsheet ID' }
    ])
    if (!answers.name || !answers.clientId || !answers.clientSecret || !answers.documentId) {
        throw new Error('Google setup cancelled; configuration was kept.')
    }
    const config = getConfig()
    const previous = config.integrations[IntegrationId.Google] as GoogleConfig | undefined
    const googleConfig: GoogleConfig = {
        ...defaultGoogleConfig,
        ...previous,
        name: answers.name,
        documentId: answers.documentId,
        credentials: {
            ...defaultGoogleConfig.credentials,
            ...previous?.credentials,
            clientId: answers.clientId,
            clientSecret: answers.clientSecret,
            redirectUri: 'http://127.0.0.1'
        }
    }
    const candidate = {
        ...config,
        integrations: { ...config.integrations, [IntegrationId.Google]: googleConfig }
    }
    const google = new GoogleIntegration(candidate, undefined, false)
    const tokens = await authorizeDesktop(google)
    const sameClient = previous?.credentials.clientId === answers.clientId
    if (!tokens.refresh_token && !(sameClient && previous?.credentials.refreshToken)) {
        throw new Error(
            'Google did not return an offline refresh token. Revoke prior app access and run `mintable google-setup` again.'
        )
    }
    updateConfig(current => {
        googleConfig.credentials.accessToken = tokens.access_token
        googleConfig.credentials.refreshToken = tokens.refresh_token || previous?.credentials.refreshToken
        googleConfig.credentials.tokenType = tokens.token_type
        googleConfig.credentials.expiryDate = tokens.expiry_date
        current.integrations[IntegrationId.Google] = googleConfig
        current.transactions.integration = IntegrationId.Google
        current.balances.integration = IntegrationId.Google
        return current
    })
    logInfo('Successfully set up Google Sheets integration.')
}
