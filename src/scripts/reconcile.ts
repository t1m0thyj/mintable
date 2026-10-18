import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import { jsonc } from 'jsonc'
import { absolutePath, readPrivate, sha256, writeNewPrivate } from '../migration/files'
import { MigrationMapping } from '../common/config'

export interface ReconcileOptions {
    oldCsv: string
    newCsv: string
    mappingFile: string
    completeMonthFile: string
    outputCsv: string
    cutoverMonth: string
    oldProvider: 'plaid' | 'teller' | 'csv'
    newProvider: 'teller' | 'csv'
}
export interface ReconcilePreview {
    reviewSha256: string
    oldRows: number
    newRows: number
    selectedOldRows: number
    selectedNewRows: number
    ignoredNewBeforeCutover: number
    possibleCrossProviderMatches: number
    blockers: string[]
    outputCsv: string
}

type Row = Record<string, string>
type Prepared = { preview: ReconcilePreview; rows: Row[]; columns: string[] }
const month = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
const isoDate = (value: string): string | undefined => {
    const normalized = value.replace(/\./g, '-')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return undefined
    const date = new Date(`${normalized}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : undefined
}
const loadRows = (file: string): { rows: Row[]; columns: string[] } => {
    const contents = readPrivate(absolutePath(file))
    const columns = parse(contents, { to_line: 1, bom: true })[0] as string[] | undefined
    if (!columns?.length || new Set(columns).size !== columns.length) {
        throw new Error('A history CSV has missing or duplicate column names.')
    }
    const rows: Row[] = parse(contents, {
        columns: (header: string[]) => {
            if (new Set(header).size !== header.length) throw new Error('A history CSV has duplicate column names.')
            return header
        },
        skip_empty_lines: true,
        bom: true
    })
    return { rows, columns }
}
const loadJson = (file: string): Record<string, unknown> => {
    let value: unknown
    try {
        value = jsonc.parse(readPrivate(absolutePath(file)))
    } catch {
        throw new Error(`Unable to parse ${file}.`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${file}.`)
    return value as Record<string, unknown>
}
const sourceId = (row: Row, fallback: string): string =>
    `${row.integration === 'csv-import' ? 'csv' : row.integration || fallback}:${row.accountId || row.account || ''}`

function prepare(options: ReconcileOptions): Prepared {
    if (!month(options.cutoverMonth)) throw new Error('Cutover month must be YYYY-MM.')
    const old = loadRows(options.oldCsv)
    const next = loadRows(options.newCsv)
    const oldRows = old.rows
    const newRows = next.rows
    const mappings = loadJson(options.mappingFile) as Record<string, MigrationMapping>
    const complete = loadJson(options.completeMonthFile)
    const blockers: string[] = []
    if (absolutePath(options.oldCsv) === absolutePath(options.newCsv))
        blockers.push('Old and new history must be different files.')
    for (const source of [old, next]) {
        if (['date', 'amount', 'name', 'accountId', 'transactionId'].some(column => !source.columns.includes(column))) {
            blockers.push('A history CSV lacks required date, amount, name, accountId, or transactionId columns.')
        }
    }
    const targetToLocal = new Map<string, string>()
    for (const [key, mapping] of Object.entries(mappings)) {
        if (
            !mapping ||
            typeof mapping !== 'object' ||
            typeof mapping.localAccountId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(mapping.localAccountId) ||
            typeof mapping.target !== 'string'
        ) {
            blockers.push('Account mapping contains an invalid entry.')
            break
        }
        if (mapping.target !== 'archive') targetToLocal.set(mapping.target, mapping.localAccountId)
        if (!key.includes(':')) blockers.push('Account mapping source keys must be provider-qualified.')
    }
    const activeLocals = new Set(targetToLocal.values())
    const acknowledged = new Set(Array.isArray(complete.localAccountIds) ? complete.localAccountIds : [])
    if (complete.cutoverMonth !== options.cutoverMonth || [...activeLocals].some(id => !acknowledged.has(id))) {
        blockers.push('Complete-month review must list every active local account identity for the cutover month.')
    }
    const selected: Row[] = []
    const oldSignatures = new Set<string>()
    const transactionKeys = new Set<string>()
    let selectedOldRows = 0
    let selectedNewRows = 0
    let ignoredNewBeforeCutover = 0
    let possibleCrossProviderMatches = 0
    const inspect = (rows: Row[], fallback: string, isOld: boolean) => {
        for (const row of rows) {
            const date = isoDate(row.date || '')
            const provider = row.integration || fallback
            if (!['plaid', 'teller', 'csv', 'csv-import'].includes(provider))
                blockers.push('A source row has an unsupported provider.')
            const local = isOld
                ? mappings[sourceId(row, fallback)]?.localAccountId
                : targetToLocal.get(sourceId(row, fallback))
            const providerId = row.transactionId
            if (!date) blockers.push('A source row lacks a full valid transaction date.')
            if (!local) blockers.push('A source row lacks a stable account mapping.')
            if (!providerId) blockers.push('A source row lacks a provider transaction ID.')
            if (!row.amount || !Number.isFinite(Number(row.amount)) || !row.name)
                blockers.push('A source row lacks amount or description.')
            if (!date || !local || !providerId) continue
            const transactionKey = `${provider}:${local}:${providerId}`
            if (transactionKeys.has(transactionKey)) blockers.push('Duplicate provider-qualified transaction ID found.')
            transactionKeys.add(transactionKey)
            const signature = `${local}\0${date}\0${row.amount}\0${row.name}`
            if (isOld) oldSignatures.add(signature)
            else if (oldSignatures.has(signature)) possibleCrossProviderMatches++
            const rowMonth = date.slice(0, 7)
            if (isOld && rowMonth >= options.cutoverMonth) {
                blockers.push('Old history reaches the cutover month; choose a later complete-month boundary.')
                continue
            }
            if (!isOld && rowMonth < options.cutoverMonth) {
                ignoredNewBeforeCutover++
                continue
            }
            selected.push({ ...row, date, mintableLocalAccountId: local, mintableSourceKey: transactionKey })
            if (isOld) selectedOldRows++
            else selectedNewRows++
        }
    }
    inspect(oldRows, options.oldProvider, true)
    inspect(newRows, options.newProvider, false)
    selected.sort((a, b) => a.date.localeCompare(b.date) || a.mintableSourceKey.localeCompare(b.mintableSourceKey))
    const columns = [...new Set([...old.columns, ...next.columns, 'mintableLocalAccountId', 'mintableSourceKey'])]
    if (
        oldRows.some(row => 'mintableLocalAccountId' in row || 'mintableSourceKey' in row) ||
        newRows.some(row => 'mintableLocalAccountId' in row || 'mintableSourceKey' in row)
    ) {
        blockers.push('Input already contains reserved Mintable reconciliation columns.')
    }
    const inputs = [options.oldCsv, options.newCsv, options.mappingFile, options.completeMonthFile].map(file =>
        sha256(fs.readFileSync(absolutePath(file)))
    )
    const reviewSha256 = sha256(
        JSON.stringify({
            inputs,
            cutover: options.cutoverMonth,
            oldProvider: options.oldProvider,
            newProvider: options.newProvider
        })
    )
    const outputCsv = absolutePath(options.outputCsv)
    if (
        inputs.some(
            (_hash, index) =>
                absolutePath(
                    [options.oldCsv, options.newCsv, options.mappingFile, options.completeMonthFile][index]
                ) === outputCsv
        )
    ) {
        blockers.push('Reconciliation output must be a separate file.')
    }
    if (fs.existsSync(outputCsv)) blockers.push('Reconciliation output already exists.')
    return {
        preview: {
            reviewSha256,
            oldRows: oldRows.length,
            newRows: newRows.length,
            selectedOldRows,
            selectedNewRows,
            ignoredNewBeforeCutover,
            possibleCrossProviderMatches,
            blockers: [...new Set(blockers)],
            outputCsv
        },
        rows: selected,
        columns
    }
}

export const previewReconciliation = (options: ReconcileOptions): ReconcilePreview => prepare(options).preview
export function applyReconciliation(options: ReconcileOptions, expectedReviewSha256: string): ReconcilePreview {
    const prepared = prepare(options)
    if (prepared.preview.reviewSha256 !== expectedReviewSha256) {
        throw new Error('Reconciliation inputs changed since preview.')
    }
    if (prepared.preview.blockers.length) throw new Error(prepared.preview.blockers.join(' '))
    const output = stringify(prepared.rows, { header: true, columns: prepared.columns })
    writeNewPrivate(prepared.preview.outputCsv, output)
    return prepared.preview
}

const value = (args: string[], key: string): string | undefined => {
    const index = args.indexOf(`--${key}`)
    if (index >= 0) return args[index + 1]
    return args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
}

export default async () => {
    const args = process.argv.slice(3)
    const options: ReconcileOptions = {
        oldCsv: value(args, 'old-csv') || '',
        newCsv: value(args, 'new-csv') || '',
        mappingFile: value(args, 'account-map-file') || '',
        completeMonthFile: value(args, 'complete-month-file') || '',
        outputCsv: value(args, 'output-csv') || '',
        cutoverMonth: value(args, 'cutover-month') || '',
        oldProvider: (value(args, 'old-provider') || 'plaid') as ReconcileOptions['oldProvider'],
        newProvider: (value(args, 'new-provider') || 'teller') as ReconcileOptions['newProvider']
    }
    if (!['plaid', 'teller', 'csv'].includes(options.oldProvider) || !['teller', 'csv'].includes(options.newProvider)) {
        throw new Error('Unsupported reconciliation provider.')
    }
    const plan = args.includes('--apply')
        ? applyReconciliation(options, value(args, 'expect-sha256') || '')
        : previewReconciliation(options)
    console.log(JSON.stringify(plan, null, 2))
}
