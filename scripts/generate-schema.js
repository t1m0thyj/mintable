const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { getProgramFromFiles, generateSchema } = require('typescript-json-schema')

const root = path.resolve(__dirname, '..')
const tsconfigPath = path.join(root, 'tsconfig.json')
const loaded = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
}
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root)
if (parsed.errors.length) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
}

const program = getProgramFromFiles([path.join(root, 'src/common/config.ts')], parsed.options, root)
const schema = generateSchema(program, 'Config', {
    required: true,
    noExtraProps: true
})
if (!schema) {
    throw new Error('Could not generate Config JSON schema')
}

const outputPath = path.join(root, 'lib/common/config.schema.json')
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(schema, null, 2) + '\n')
