#!/usr/bin/env node
/**
 * 装完之后跑一遍：确认包在磁盘上还是完整的。
 *
 * 为什么需要它：pnpm 12 在 Windows 上把**内容完全相同**的文件硬链到同一个 store inode，
 * 一个包里多个子目录出现同样字节时，安装后只会留下其中一份（实测 6 个 `{"type":"commonjs"}`
 * 标记只活下来 1 个，其余 5 个目录的 CJS 就被当成 ESM 解析，`dshHome` 之类的命名导出找不到）。
 * 同理，`bin` 指向的文件若没被 `files` 收进 tarball，装完就是死链接。
 *
 * 用法：
 *   node tools/check-install.mjs                 # 检查本文件所在包
 *   node tools/check-install.mjs <包目录>         # 检查指定安装目录
 *   node tools/check-install.mjs --quiet         # 只打印失败项
 *
 * 退出码：0 全过；1 有失败项。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const positional = args.filter((a) => !a.startsWith('--'))
const root = path.resolve(positional[0] || path.join(here, '..'))

const failures = []
const notes = []

function ok(msg) {
  if (!quiet) console.log(`  ok   ${msg}`)
}
function fail(msg) {
  failures.push(msg)
  console.log(`  FAIL ${msg}`)
}
function note(msg) {
  notes.push(msg)
  if (!quiet) console.log(`  note ${msg}`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

console.log(`检查 ${root}`)

// 1. 根 package.json
let pkg
try {
  pkg = readJson(path.join(root, 'package.json'))
  ok(`package.json 可解析：${pkg.name}@${pkg.version}`)
} catch (error) {
  fail(`package.json 读不出来：${error.message}`)
  console.log('\n有失败项，先修再装。')
  process.exit(1)
}

// 2. main / bundle patch / client 入口
const clientRelRaw = pkg.dsh?.client?.entry || 'lib/client.js'
for (const [label, rel] of [
  ['main', pkg.main],
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
]) {
  if (!rel) {
    fail(`${label} 没声明`)
    continue
  }
  if (fs.existsSync(path.join(root, rel))) ok(`${label} → ${rel}`)
  else fail(`${label} 指向不存在的文件：${rel}`)
}

// 3. bin 必须是真文件
const bins = Object.entries(pkg.bin || {})
if (bins.length === 0) ok('没有 bin 声明（不会出现死命令）')
for (const [name, rel] of bins) {
  if (fs.existsSync(path.join(root, rel))) ok(`bin ${name} → ${rel}`)
  else fail(`bin ${name} 指向不存在的文件：${rel}（npm 不会报错，装完就是一敲就失败）`)
}

// 4. CJS 文件必须落在「按 CJS 解析」的作用域里
//    判定：最近的 package.json 若写了 "type": "module" 就必须在更近处再放一个
//    {"type":"commonjs"} 标记；没写 type 的嵌套 package.json 默认就是 CJS，不用管。
const files = walk(root)
const pkgFiles = files.filter((f) => path.basename(f) === 'package.json')
const pkgMeta = new Map()
for (const file of pkgFiles) {
  try {
    pkgMeta.set(path.dirname(file), readJson(file))
  } catch (error) {
    fail(`坏掉的 package.json：${path.relative(root, file)}（${error.message}）`)
  }
}
function nearestPkg(dir) {
  let cur = dir
  while (cur.startsWith(root)) {
    if (pkgMeta.has(cur)) return { dir: cur, meta: pkgMeta.get(cur) }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}
const clientEntry = path.resolve(root, clientRelRaw || 'lib/client.js')
const badScope = new Set()
for (const file of files) {
  if (!file.endsWith('.js')) continue
  if (path.resolve(file) === clientEntry) continue // 浏览器端 bundle，不归 Node 管
  const text = fs.readFileSync(file, 'utf8')
  const looksCjs = /\bmodule\.exports\b/.test(text) || /(^|[^.\w])require\(/.test(text)
  const looksEsm = /(^|\n)\s*(import|export)\s/.test(text)
  if (!looksCjs || looksEsm) continue
  const nearest = nearestPkg(path.dirname(file))
  if (!nearest) continue
  if (nearest.meta.type === 'module') badScope.add(path.relative(root, path.dirname(file)))
}
if (badScope.size === 0) ok('所有 CJS 文件都落在按 CJS 解析的作用域里')
for (const dir of badScope) fail(`CJS 文件所在目录会被当成 ESM 解析（缺 {"type":"commonjs"} 标记）：${dir}`)

// 5. 内容重复的文件（pnpm 会把它们合并成一份）
const byHash = new Map()
for (const file of files) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const list = byHash.get(hash) || []
  list.push(path.relative(root, file))
  byHash.set(hash, list)
}
const dups = [...byHash.values()].filter((list) => list.length > 1)
if (dups.length === 0) ok('没有内容完全相同的重复文件')
for (const list of dups) {
  fail(`内容完全相同的文件（装完只会剩一份）：${list.join(' | ')}`)
}

// 6. 客户端入口的注册名必须等于包名
const clientRel = clientRelRaw
const clientFile = path.join(root, clientRel)
if (!fs.existsSync(clientFile)) {
  note(`没有客户端入口 ${clientRel}（纯服务端插件可忽略）`)
} else {
  const text = fs.readFileSync(clientFile, 'utf8')
  const match = text.match(/__ModuleLoader__\.load\(\{[\s\S]{0,200}?id:\s*'([^']+)'/)
  if (!match) fail(`${clientRel} 里找不到 __ModuleLoader__.load({ id: … })`)
  else if (match[1] !== pkg.name) {
    fail(`客户端注册名 "${match[1]}" ≠ 包名 "${pkg.name}"：宿主会报 loaded without registering，界面整块不出现`)
  } else ok(`客户端注册名与包名一致：${match[1]}`)
}

// 汇总
if (failures.length === 0) {
  console.log(`\n全部通过（${files.length} 个文件）。`)
  for (const n of notes) console.log(`note ${n}`)
  process.exit(0)
}
console.log(`\n${failures.length} 项失败：`)
for (const f of failures) console.log(` - ${f}`)
process.exit(1)
