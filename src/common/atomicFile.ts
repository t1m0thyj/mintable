import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

export function writeFileAtomic(destination: string, data: string, mode = 0o600): void {
    const resolved = path.resolve(destination)
    const temporary = path.join(
        path.dirname(resolved),
        `.${path.basename(resolved)}.${randomBytes(8).toString('hex')}.tmp`
    )
    try {
        fs.writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx', mode })
        fs.renameSync(temporary, resolved)
        if (process.platform !== 'win32') fs.chmodSync(resolved, mode)
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
}
