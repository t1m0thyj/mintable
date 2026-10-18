import { existsSync, realpathSync } from 'fs'
import prompts from 'prompts'
import { TellerConfig, defaultTellerConfig } from '../../types/integrations/teller'
import { updateConfig, getConfig } from '../../common/config'
import { IntegrationId } from '../../types/integrations'
import { logInfo } from '../../common/logging'

export default async () => {
    const previous = getConfig().integrations[IntegrationId.Teller] as TellerConfig | undefined
    console.log(
        '\nConfigure your Teller application. Development and production connect to real banks. Sandbox uses test data.\n'
    )
    const environmentResponse = await prompts({
        type: 'select',
        name: 'environment',
        message: 'Teller environment',
        initial: ['development', 'sandbox', 'production'].indexOf(previous?.environment || 'development'),
        choices: [
            { title: 'Development (real bank data)', value: 'development' },
            { title: 'Sandbox (test data)', value: 'sandbox' },
            { title: 'Production (real bank data)', value: 'production' }
        ]
    })
    if (!environmentResponse.environment) throw new Error('Teller setup cancelled.')
    const credentials = await prompts([
        {
            type: 'text',
            name: 'name',
            message: 'Integration name',
            initial: previous?.name || 'Teller',
            validate: (s: string) => (s.length >= 2 && s.length <= 64) || 'Use 2–64 characters.'
        },
        {
            type: 'text',
            name: 'appId',
            message: 'Teller application ID',
            initial: previous?.appId || '',
            validate: (s: string) => /^app_[A-Za-z0-9_-]+$/.test(s) || 'Enter your Teller application ID.'
        },
        {
            type: 'text',
            name: 'pathCertificate',
            message: 'Certificate file path (blank in sandbox)',
            initial: previous?.pathCertificate || '',
            validate: (s: string) =>
                (s && existsSync(s)) ||
                (!s && environmentResponse.environment === 'sandbox') ||
                'Enter an existing certificate file.'
        },
        {
            type: 'text',
            name: 'pathPrivateKey',
            message: 'Private key file path (blank in sandbox)',
            initial: previous?.pathPrivateKey || '',
            validate: (s: string) =>
                (s && existsSync(s)) ||
                (!s && environmentResponse.environment === 'sandbox') ||
                'Enter an existing private key file.'
        }
    ])
    if (
        !credentials.name ||
        !credentials.appId ||
        (environmentResponse.environment !== 'sandbox' && (!credentials.pathCertificate || !credentials.pathPrivateKey))
    ) {
        throw new Error('Teller setup cancelled.')
    }
    updateConfig(config => {
        config.integrations[IntegrationId.Teller] = {
            ...defaultTellerConfig,
            name: credentials.name,
            appId: credentials.appId,
            environment: environmentResponse.environment,
            pathCertificate: credentials.pathCertificate ? realpathSync(credentials.pathCertificate) : '',
            pathPrivateKey: credentials.pathPrivateKey ? realpathSync(credentials.pathPrivateKey) : ''
        }
        return config
    })
    logInfo('Teller integration configured.')
}
