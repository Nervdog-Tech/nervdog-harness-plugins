// Packs icons/png/<size>.png (from make-icons.ps1; git-ignored) into icons/nervdog-harness.ico with PNG-compressed frames.
// Run from brand/: node scripts/pack-ico.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')
const frames = readdirSync(join(here, 'png'))
  .map(name => ({ size: Number.parseInt(name, 10), data: readFileSync(join(here, 'png', name)) }))
  .filter(frame => Number.isInteger(frame.size) && frame.size >= 1 && frame.size <= 256)
  .sort((a, b) => a.size - b.size)
const header = Buffer.alloc(6 + 16 * frames.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(frames.length, 4)
let offset = header.length
frames.forEach((frame, i) => {
  const at = 6 + 16 * i
  header.writeUInt8(frame.size === 256 ? 0 : frame.size, at)
  header.writeUInt8(frame.size === 256 ? 0 : frame.size, at + 1)
  header.writeUInt8(0, at + 2)
  header.writeUInt8(0, at + 3)
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(frame.data.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += frame.data.length
})
const ico = Buffer.concat([header, ...frames.map(frame => frame.data)])
writeFileSync(join(here, 'nervdog-harness.ico'), ico)
console.log(`nervdog-harness.ico: ${frames.map(frame => frame.size).join(', ')} px, ${(ico.length / 1024).toFixed(1)} KB`)
