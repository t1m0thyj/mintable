#!/usr/bin/env node
import prompts from 'prompts'
import { updateConfig, readConfig, getConfigSource } from '../common/config'
import google from '../integrations/google/setup'
import csvImport from '../integrations/csv-import/setup'
import csvExport from '../integrations/csv-export/setup'
import teller from '../integrations/teller/setup'
import tellerAccountSetup from '../integrations/teller/accountSetup'
import fetch from './fetch'
import migrate from './migrate'
import reconcile from './reconcile'

const commands: { [name: string]: () => Promise<unknown> | unknown } = {
    migrate,
    reconcile,
    fetch,
    'plaid-setup': () => {
        throw new Error(
            'Plaid setup has been removed. Use `mintable migrate --source-file PATH` to preview conversion, or `mintable setup` for a fresh v3 config.'
        )
    },
    'account-setup': tellerAccountSetup,
    'teller-account-setup': tellerAccountSetup,
    'teller-setup': teller,
    'google-setup': google,
    'csv-import-setup': csvImport,
    'csv-export-setup': csvExport
}

async function setup(): Promise<void> {
    const source = getConfigSource()
    if (readConfig(source, true)) {
        const answer = await prompts({
            type: 'confirm',
            name: 'overwrite',
            message: 'Overwrite the existing configuration?',
            initial: false
        })
        if (answer.overwrite !== true) throw new Error('Setup cancelled; existing configuration was kept.')
    }
    const importChoice = await prompts({
        type: 'select',
        name: 'source',
        message: 'How will you import account data?',
        choices: [
            { title: 'Teller (connect to banks)', value: 'teller' },
            { title: 'CSV files only', value: 'csv' }
        ]
    })
    if (!importChoice.source) throw new Error('Setup cancelled.')
    const exportChoice = await prompts({
        type: 'select',
        name: 'destination',
        message: 'Where will you export data?',
        choices: [
            { title: 'Google Sheets', value: 'google' },
            { title: 'CSV files', value: 'csv' }
        ]
    })
    if (!exportChoice.destination) throw new Error('Setup cancelled.')
    updateConfig(config => config, true)
    if (importChoice.source === 'teller') await teller()
    else await csvImport()
    if (exportChoice.destination === 'google') await google()
    else await csvExport()
    if (importChoice.source === 'teller') await tellerAccountSetup()
}

async function main(): Promise<void> {
    const command = process.argv[2]
    if (command === 'setup') return setup()
    if (Object.prototype.hasOwnProperty.call(commands, command)) {
        await commands[command]()
        return
    }
    console.log(`Mintable v${require('../../package.json').version}`)
    console.log('usage: mintable <command>')
    console.log(
        'commands: setup, fetch, account-setup, teller-setup, csv-import-setup, csv-export-setup, google-setup, migrate, reconcile'
    )
    console.log('account-setup uses Teller; add --port=PORT to choose the local setup port.')
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Command failed.')
    process.exitCode = 1
})
