import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PROFILE_SUFFIX,
  UPSTREAM_FOLDER_NAME,
  parseProfile,
  readArchive,
  readWorkspaceMemory,
  resolveArchiveCandidates,
  serializeProfile,
} from '../lib/archive.js'

test('serialize → parse 往返保留全部字段', () => {
  const profile = {
    uid: 'u-1',
    memoryBlock: '用户偏好 TypeScript',
    memoryIndex: '<memory_index>x</memory_index>',
    version: 47,
    updatedAt: '2026-10-19T15:23:13+08:00',
  }
  const markdown = serializeProfile(profile)
  assert.match(markdown, /^# User Memory Profile/)
  assert.match(markdown, /^> Version: 47$/m)

  const back = parseProfile(markdown, 'u-1')
  assert.equal(back.uid, 'u-1')
  assert.equal(back.version, 47)
  assert.equal(back.memoryBlock, '用户偏好 TypeScript')
  assert.equal(back.memoryIndex, '<memory_index>x</memory_index>')
})

test('RAW_JSON 损坏时回退到头部与正文正则解析', () => {
  const broken = [
    '# User Memory Profile',
    '> Last updated: 2026-01-02T03:04:05Z',
    '> Version: 12',
    '',
    '## Memory Block',
    '',
    '正文内容',
    '',
    '---',
    '',
    '<!-- RAW_JSON_START',
    '{ this is not json',
    'RAW_JSON_END -->',
    '',
  ].join('\n')

  const parsed = parseProfile(broken, 'u-2')
  assert.equal(parsed.version, 12)
  assert.equal(parsed.updatedAt, '2026-01-02T03:04:05Z')
  assert.equal(parsed.memoryBlock, '正文内容')
  assert.equal(parsed.uid, 'u-2')
})

test('归档内 uid 与请求不符时以请求 uid 覆盖', () => {
  const markdown = serializeProfile({ uid: 'someone-else', memoryBlock: 'x', version: 3 })
  const parsed = parseProfile(markdown, 'u-3')
  assert.equal(parsed.uid, 'u-3')
  assert.equal(parsed.version, 3)
})

test('候选路径按平台化 → 扁平 → legacy 排序', () => {
  const candidates = resolveArchiveCandidates({ archiveRoot: '/cfg', uid: 'u-1', enterpriseId: 'ent' })
  assert.deepEqual(candidates, [
    path.join('/cfg', 'memory', 'platform', 'ent', `u-1${PROFILE_SUFFIX}`),
    path.join('/cfg', 'memory', `u-1${PROFILE_SUFFIX}`),
    path.join('/cfg', 'memery', 'u-1_memery.md'),
  ])
})

test('uid 为空时不产出候选路径', () => {
  assert.deepEqual(resolveArchiveCandidates({ archiveRoot: '/cfg', uid: '' }), [])
})

test('readArchive 在多候选间取 mtime 最新者', async () => {
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'dsh-mem-arch-'))
  await mkdir(path.join(archiveRoot, 'memory', 'platform', 'personal'), { recursive: true })
  const flat = path.join(archiveRoot, 'memory', 'u-9_memory.md')
  const platform = path.join(archiveRoot, 'memory', 'platform', 'personal', 'u-9_memory.md')

  await writeFile(flat, serializeProfile({ uid: 'u-9', memoryBlock: 'old', version: 1 }), 'utf-8')
  await writeFile(platform, serializeProfile({ uid: 'u-9', memoryBlock: 'new', version: 2 }), 'utf-8')
  await utimes(flat, new Date('2026-01-01'), new Date('2026-01-01'))

  const archive = await readArchive({ archiveRoot, uid: 'u-9' })
  assert.equal(archive.file, platform)
  assert.equal(archive.profile.version, 2)
  assert.equal(archive.profile.memoryBlock, 'new')
})

test('readWorkspaceMemory 取文件名最大的日誌并读项目说明', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-mem-ws-'))
  const dir = path.join(workspace, UPSTREAM_FOLDER_NAME, 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, '2026-11-10.md'), '昨天', 'utf-8')
  await writeFile(path.join(dir, '2026-11-11.md'), '今天', 'utf-8')
  await writeFile(path.join(dir, 'MEMORY.md'), '项目说明', 'utf-8')

  const memory = await readWorkspaceMemory(workspace)
  assert.equal(memory.instructions, '项目说明')
  assert.equal(memory.latestDaily.name, '2026-11-11.md')
  assert.equal(memory.latestDaily.text, '今天')
})

test('无记忆目录时返回 undefined 而不抛错', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-mem-empty-'))
  assert.equal(await readWorkspaceMemory(workspace), undefined)
})
