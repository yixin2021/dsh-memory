import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8'))

/** 宿主的语言文件名规则：`en`、`zh`、`pt-BR` 合法，`zh_CN`、`messages` 不合法。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
/** 宿主允许的图标体积上限。 */
const MAX_ICON_BYTES = 256 * 1024

/**
 * 建一个临时的 node_modules，把本包软链进去，让 Node 按 exports 真实解析。
 * 直接读 package.json 拼路径会漏掉"忘了写 exports"这类问题——宿主正是走包解析。
 */
async function createResolver() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-mem-meta-'))
  await mkdir(path.join(dir, 'node_modules'), { recursive: true })
  await symlink(root, path.join(dir, 'node_modules', manifest.name), 'dir')
  await writeFile(path.join(dir, 'entry.mjs'), '', 'utf-8')
  return createRequire(path.join(dir, 'entry.mjs'))
}

async function readLocale(name) {
  const require = await createResolver()
  return JSON.parse(await readFile(require.resolve(`${manifest.name}/locale/${name}`), 'utf-8'))
}

test('英文语言文件能通过 exports 被宿主解析到', async () => {
  const require = await createResolver()
  const file = require.resolve(`${manifest.name}/locale/en.json`)
  assert.ok(file.endsWith(path.join('locale', 'en.json')))
})

test('图标能通过 exports 被宿主解析到', async () => {
  const require = await createResolver()
  const file = require.resolve(`${manifest.name}/icon`)
  assert.ok(file.endsWith('icon.svg'))
  const { size } = await stat(file)
  assert.ok(size > 0 && size <= MAX_ICON_BYTES, `图标体积 ${size} 超出宿主上限`)
  assert.match(await readFile(file, 'utf-8'), /^\s*<svg[\s>]/u)
})

test('locale 目录里只有合法语言 id 的文件', async () => {
  const entry = await readdir(path.join(root, 'locale'))
  assert.ok(entry.includes('en.json'), 'en.json 是宿主的入口，缺了整块元数据都不显示')
  for (const name of entry) {
    if (!name.endsWith('.json')) continue
    assert.match(name.slice(0, -5), LANGUAGE_ID, `${name} 不是合法语言 id`)
  }
})

test('每个语言文件都给出 title 与 description 且非空', async () => {
  for (const name of await readdir(path.join(root, 'locale'))) {
    if (!name.endsWith('.json')) continue
    const locale = await readLocale(name)
    const meta = locale.meta
    assert.equal(typeof meta, 'object', `${name} 缺少 meta`)
    for (const field of ['title', 'description']) {
      assert.equal(typeof meta[field], 'string', `${name} 的 meta.${field} 必须是字符串`)
      assert.notEqual(meta[field].trim(), '', `${name} 的 meta.${field} 不能为空`)
    }
    assert.ok(meta.title.length <= 24, `${name} 的标题在卡片上会被截断`)
    assert.ok(meta.description.length <= 200, `${name} 的说明过长，卡片放不下`)
  }
})

test('中英文覆盖同一组字段，标题确实覆盖了包名', async () => {
  const en = await readLocale('en.json')
  const zh = await readLocale('zh.json')
  assert.deepEqual(Object.keys(en.meta).sort(), Object.keys(zh.meta).sort())
  assert.notEqual(en.meta.title, manifest.name, '英文标题不能落回包名，否则列表里只有 dsh-memory')
  assert.notEqual(zh.meta.title, en.meta.title, '中文标题应当是译文而不是英文原文')
})

test('语言文件被 files 白名单收录，git 安装不会漏发', async () => {
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(manifest.files.includes('icon.svg'))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
})
