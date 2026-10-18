import { Config, getConfig } from '../../common/config'
import { logInfo } from '../../common/logging'
import open from 'open'
import { SetupServerOptions, startTellerSetupServer } from './setupServer'

export async function runTellerAccountSetup(
    config: Config,
    options: SetupServerOptions = {},
    launch: (url: string) => Promise<unknown> = open
): Promise<void> {
    const session = await startTellerSetupServer(config, options)
    try {
        await launch(session.url)
        logInfo('Teller account setup is open in your browser. Select Done or Cancel there to finish.')
        await session.done
        logInfo('Teller account setup complete.')
    } catch (error) {
        await session.close()
        throw error
    }
}

export default async () => {
    const config = getConfig()
    const portArgument = process.argv.find(value => value.startsWith('--port='))?.slice('--port='.length)
    const port = portArgument === undefined ? 0 : Number(portArgument)
    await runTellerAccountSetup(config, { port })
}
