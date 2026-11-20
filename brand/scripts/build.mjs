// Builds lib/client.js: inlines assets/LuckiestGuy.ttf and assets/mark.png as data URLs into src/client.js and wraps it in
// the client module loader, the same wrapper tsdown emits for the harness packages. Run from brand/: node scripts/build.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const dataUrl = (file, type) => `data:${type};base64,${readFileSync(join(here, 'assets', file)).toString('base64')}`

const body = readFileSync(join(here, 'src', 'client.js'), 'utf8')
  .replace('"__FONT_DATA__"', JSON.stringify(dataUrl('LuckiestGuy.ttf', 'font/ttf')))
  .replace('"__MARK_DATA__"', JSON.stringify(dataUrl('mark.png', 'image/png')))
if (body.includes('__FONT_DATA__') || body.includes('__MARK_DATA__')) throw new Error('asset placeholder left in client bundle')

const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
mkdirSync(join(here, 'lib'), { recursive: true })
writeFileSync(join(here, 'lib', 'client.js'), out)
console.log(`lib/client.js ${(out.length / 1024).toFixed(1)} KB`)
