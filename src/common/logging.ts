const chalk = require('chalk')

export enum LogLevel {
    Info = 'info',
    Warn = 'warn',
    Error = 'error'
}

export class MintableError extends Error {
    readonly cause?: unknown
    constructor(
        readonly code: string,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message)
        this.name = 'MintableError'
        this.cause = options?.cause
    }
}

export interface LogRequest {
    level: LogLevel
    message: string
    data?: unknown
}

export const log = (request: LogRequest): void => {
    if (request.level === LogLevel.Error) throw new MintableError('operation', request.message, { cause: request.data })
    const text = `${new Date().toISOString()} [${request.level.toUpperCase()}] ${request.message}`
    if (request.level === LogLevel.Warn) console.warn(chalk.yellow(text))
    else console.info(text)
}

export const logError = (message: string, data?: unknown): never => {
    throw new MintableError('operation', message, { cause: data })
}

export const logWarn = (message: string, _data?: unknown): void => log({ level: LogLevel.Warn, message })

export const logInfo = (message: string, _data?: unknown): void => log({ level: LogLevel.Info, message })
