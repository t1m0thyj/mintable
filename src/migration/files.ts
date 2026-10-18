import fs from 'fs'
import path from 'path'
import { randomBytes, createHash } from 'crypto'

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const absolutePath = (value: string): string =>
    path.resolve(value.replace(/^~(?=$|[\\/])/, require('os').homedir()))

export function readPrivate(pathname: string): string {
    return fs.readFileSync(pathname, 'utf8')
}

export function archiveBytes(pathname: string, contents: Buffer): string {
    const name = `${pathname}.pre-v3-${sha256(contents).slice(0, 12)}.bak`
    if (fs.existsSync(name)) {
        if (sha256(fs.readFileSync(name)) !== sha256(contents)) throw new Error(`Existing backup differs: ${name}`)
        return name
    }
    const descriptor = fs.openSync(name, 'wx', 0o600)
    try {
        fs.writeFileSync(descriptor, contents)
        fs.fsyncSync(descriptor)
    } finally {
        fs.closeSync(descriptor)
    }
    try {
        fs.chmodSync(name, 0o600)
    } catch {
        /* Windows may retain inherited ACLs. */
    }
    return name
}

export function writeNewPrivate(pathname: string, contents: string): 'written' | 'unchanged' {
    if (fs.existsSync(pathname)) {
        if (fs.readFileSync(pathname, 'utf8') === contents) return 'unchanged'
        throw new Error(`Destination exists and differs: ${pathname}`)
    }
    const directory = path.dirname(pathname)
    if (!fs.existsSync(directory)) throw new Error(`Destination directory does not exist: ${directory}`)
    const temporary = path.join(directory, `.${path.basename(pathname)}.${randomBytes(8).toString('hex')}.tmp`)
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
        fs.writeFileSync(descriptor, contents)
        fs.fsyncSync(descriptor)
    } finally {
        fs.closeSync(descriptor)
    }
    try {
        fs.linkSync(temporary, pathname)
        try {
            fs.chmodSync(pathname, 0o600)
        } catch {
            /* Windows may retain inherited ACLs. */
        }
    } finally {
        fs.unlinkSync(temporary)
    }
    return 'written'
}

export function replacePrivate(pathname: string, contents: string): void {
    const directory = path.dirname(pathname)
    const temporary = path.join(directory, `.${path.basename(pathname)}.${randomBytes(8).toString('hex')}.tmp`)
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
        fs.writeFileSync(descriptor, contents)
        fs.fsyncSync(descriptor)
    } finally {
        fs.closeSync(descriptor)
    }
    try {
        fs.renameSync(temporary, pathname)
        try {
            fs.chmodSync(pathname, 0o600)
        } catch {
            /* Windows may retain inherited ACLs. */
        }
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
}
