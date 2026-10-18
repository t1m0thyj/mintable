import { sheets_v4 } from 'googleapis'

export const KEY_COLUMN = '_mintable_key'

export function columnLetter(index: number): string {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid spreadsheet column index.')
    let number = index + 1
    let result = ''
    while (number > 0) {
        number--
        result = String.fromCharCode(65 + (number % 26)) + result
        number = Math.floor(number / 26)
    }
    return result
}

export interface KeyedRow {
    key: string
    values: unknown[]
}

function cell(value: unknown): sheets_v4.Schema$CellData {
    if (value === undefined || value === null || value === '') return {}
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Cannot write a non-finite number to Google Sheets.')
        return { userEnteredValue: { numberValue: value } }
    }
    if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } }
    return { userEnteredValue: { stringValue: String(value) } }
}

function rowRequest(sheetId: number, rowIndex: number, values: unknown[]): sheets_v4.Schema$Request {
    return {
        updateCells: {
            range: {
                sheetId,
                startRowIndex: rowIndex,
                endRowIndex: rowIndex + 1,
                startColumnIndex: 0,
                endColumnIndex: values.length
            },
            rows: [{ values: values.map(cell) }],
            fields: 'userEnteredValue'
        }
    }
}

export function planKeyedSheet(
    title: string,
    sheetId: number,
    gridRows: number,
    existing: unknown[][],
    columns: string[],
    incoming: KeyedRow[],
    complete: boolean,
    canRetire: (key: string) => boolean = () => true
): sheets_v4.Schema$Request[] {
    if (!columns.length || columns.includes(KEY_COLUMN)) throw new Error(`Invalid managed columns for ${title}.`)
    const headers = [...columns, KEY_COLUMN]
    const priorHeader = existing[0] || []
    if (priorHeader.some(value => value !== '' && value !== null && value !== undefined)) {
        if (headers.some((value, index) => priorHeader[index] !== value)) {
            throw new Error(
                `Sheet ${title} uses an older or different column layout. Copy it for backup and use a fresh destination, or migrate it to the keyed layout before fetching.`
            )
        }
    }

    const keyIndex = columns.length
    const locations = new Map<string, number>()
    for (let rowIndex = 1; rowIndex < existing.length; rowIndex++) {
        const row = existing[rowIndex] || []
        const key = row[keyIndex]
        if (!key) {
            if (row.slice(0, keyIndex).some(value => value !== '' && value !== null && value !== undefined)) {
                throw new Error(
                    `Sheet ${title} has unkeyed generated rows; move to a fresh destination before fetching.`
                )
            }
            continue
        }
        if (typeof key !== 'string') throw new Error(`Sheet ${title} has an invalid transaction key.`)
        const canonical = key.startsWith('retired:') ? key.slice('retired:'.length) : key
        if (locations.has(canonical)) throw new Error(`Sheet ${title} has duplicate transaction keys.`)
        locations.set(canonical, rowIndex)
    }

    const requests: sheets_v4.Schema$Request[] = [rowRequest(sheetId, 0, headers)]
    const seen = new Set<string>()
    let appendAt = Math.max(existing.length, 1)
    for (const row of incoming) {
        if (!row.key || row.key.startsWith('retired:') || row.values.length !== columns.length || seen.has(row.key)) {
            throw new Error(`Sheet ${title} received an invalid or duplicate generated key.`)
        }
        seen.add(row.key)
        const index = locations.get(row.key) ?? appendAt++
        requests.push(rowRequest(sheetId, index, [...row.values, row.key]))
    }

    if (complete) {
        for (const [key, index] of locations) {
            if (!seen.has(key) && canRetire(key)) {
                requests.push(rowRequest(sheetId, index, [...columns.map(() => ''), `retired:${key}`]))
            }
        }
    }
    if (appendAt > gridRows) {
        requests.unshift({ appendDimension: { sheetId, dimension: 'ROWS', length: appendAt - gridRows } })
    }
    return requests
}
