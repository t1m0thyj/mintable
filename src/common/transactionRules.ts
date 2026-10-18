import { Account } from '../types/account'
import { Transaction, TransactionRule } from '../types/transaction'

export const validateTransactionRules = (rules: TransactionRule[] = []): void => {
    for (let index = 0; index < rules.length; index++) {
        const rule = rules[index]
        try {
            for (const condition of rule.conditions) new RegExp(condition.pattern, condition.flags)
            if (rule.type === 'override') new RegExp(rule.findPattern, rule.flags)
        } catch (_) {
            throw new Error(`Transaction rule ${index + 1} contains an invalid regular expression or flags.`)
        }
    }
}

export const applyTransactionRules = (
    accounts: Account[],
    rules: TransactionRule[]
): { accounts: Account[]; countOverridden: number } => {
    validateTransactionRules(rules)
    let countOverridden = 0
    const updated = accounts.map(account => ({
        ...account,
        transactions: account.transactions
            .map(transaction => {
                rules.forEach(rule => {
                    const matches = rule.conditions.every(condition =>
                        new RegExp(condition.pattern, condition.flags).test(transaction?.[condition.property])
                    )
                    if (!transaction || !matches) return
                    if (rule.type === 'filter') {
                        transaction = undefined
                    } else if (transaction.hasOwnProperty(rule.property)) {
                        transaction[rule.property] = transaction[rule.property]
                            .toString()
                            .replace(new RegExp(rule.findPattern, rule.flags), rule.replacePattern)
                        countOverridden += 1
                    }
                })
                return transaction
            })
            .filter((transaction): transaction is Transaction => transaction !== undefined)
    }))
    return { accounts: updated, countOverridden }
}
