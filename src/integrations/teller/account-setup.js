;(async () => {
    const credential = location.hash.slice(1)
    history.replaceState(null, '', location.pathname)
    const status = document.getElementById('status')
    const current = document.getElementById('accounts-table')
    const available = document.getElementById('add-accounts-table')
    const addSection = document.getElementById('add-accounts')
    let setup
    let existing = []

    const request = async (route, body = {}) => {
        const response = await fetch(route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Mintable-Session': credential },
            body: JSON.stringify(body)
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Account setup request failed.')
        return data
    }
    const fail = error => {
        status.textContent = error.message || 'Account setup failed.'
    }
    const button = (label, action) => {
        const element = document.createElement('button')
        element.type = 'button'
        element.textContent = label
        element.addEventListener('click', () => Promise.resolve(action()).catch(fail))
        return element
    }
    const renderCurrent = async () => {
        existing = await request('/accounts')
        current.replaceChildren()
        if (!existing.length) {
            current.textContent = 'No Teller accounts linked yet.'
            return
        }
        for (const account of existing) {
            const row = document.createElement('p')
            const name = document.createElement('span')
            name.textContent = `${account.label} (${account.id}) `
            row.append(name)
            row.append(button('Repair connection', () => connect(account.enrollmentId)))
            row.append(
                button('Remove locally', async () => {
                    if (!confirm(`Remove ${account.label} from Mintable? Teller access is not revoked.`)) return
                    await request('/remove', { accountId: account.id })
                    await renderCurrent()
                })
            )
            current.append(row)
        }
    }
    const renderAvailable = accounts => {
        available.replaceChildren()
        const eligible = accounts.filter(account => !existing.some(saved => saved.id === account.id))
        if (!eligible.length) available.textContent = 'No additional accounts were found for this enrollment.'
        for (const account of eligible) {
            const row = document.createElement('p')
            const name = document.createElement('span')
            name.textContent = `${account.label} (${account.id}) `
            row.append(name)
            row.append(
                button('Add', async () => {
                    await request('/register', { accountId: account.id })
                    row.remove()
                    await renderCurrent()
                })
            )
            available.append(row)
        }
        addSection.hidden = false
    }
    const connect = enrollmentId => {
        status.textContent = enrollmentId ? 'Repairing Teller connection…' : 'Opening Teller Connect…'
        const options = {
            applicationId: setup.applicationId,
            environment: setup.environment,
            products: ['balance', 'transactions'],
            onSuccess: async enrollment => {
                try {
                    const accounts = await request('/enrollment', enrollment)
                    await renderCurrent()
                    renderAvailable(accounts)
                    status.textContent = 'Connection ready. Choose accounts to add, or finish setup.'
                } catch (error) {
                    fail(error)
                }
            },
            onExit: () => {
                status.textContent = 'Teller Connect was closed.'
            }
        }
        if (enrollmentId) options.enrollmentId = enrollmentId
        TellerConnect.setup(options).open()
    }
    try {
        if (!credential) throw new Error('Setup session is missing. Restart mintable account-setup.')
        setup = await request('/setup')
        document.getElementById('environment').textContent =
            `Environment: ${setup.environment}${setup.environment === 'sandbox' ? ' (test data)' : ' (real bank data)'}`
        await renderCurrent()
        document.getElementById('link-button').addEventListener('click', () => connect())
        document.getElementById('done-button').addEventListener('click', async () => {
            try {
                await request('/done')
                document.getElementById('container').textContent = 'Setup complete. You can close this tab.'
            } catch (error) {
                fail(error)
            }
        })
        document.getElementById('cancel-button').addEventListener('click', async () => {
            try {
                await request('/cancel')
                document.getElementById('container').textContent = 'Setup cancelled. You can close this tab.'
            } catch (error) {
                fail(error)
            }
        })
    } catch (error) {
        fail(error)
    }
})()
