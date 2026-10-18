const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const output = path.resolve(root, 'lib')
if (output !== path.join(root, 'lib') || !output.startsWith(root + path.sep)) {
    throw new Error('Build output must stay inside the repository.')
}
if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output)
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(output) !== output) {
        throw new Error('Build output is not a local directory.')
    }
    fs.rmSync(output, { recursive: true, force: true })
}
