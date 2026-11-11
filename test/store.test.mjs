import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  RECORDS_FILE,
  appendRecord,
  compact,
  createRecordId,
  loadRecords,
  withLock,
} from '../lib/store.js'

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'dsh-mem-store-'))
}

test('追加后可按 id 折叠读取', async () => {
  const dir = await tempDir()
  const id = createRecordId()
  await appendRecord(dir, { id, action: 'add', text: '第一条', ts: '2026-11-11T00:00:00Z' })
  await appendRecord(dir, { id, action: 'correct', text: '修正后', ts: '2026-11-11T00:01:00Z' })

  const { records, lines } = await loadRecords(dir)
  assert.equal(lines, 2)
  assert.equal(records.length, 1)
  assert.equal(records[0].text, '修正后')
})

test('delete 事件折叠后记录消失', async () => {
  const dir = await tempDir()
  const id = createRecordId()
  await appendRecord(dir, { id, action: 'add', text: '要删除的', ts: '2026-11-11T00:00:00Z' })
  await appendRecord(dir, { id, action: 'delete', ts: '2026-11-11T00:02:00Z' })

  const { records } = await loadRecords(dir)
  assert.deepEqual(records, [])
})

test('损坏行被跳过，其余记录仍可用', async () => {
  const dir = await tempDir()
  await appendRecord(dir, { id: 'mem_a', action: 'add', text: '有效', ts: '2026-11-11T00:00:00Z' })
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path.join(dir, RECORDS_FILE), '{ broken json\n', 'utf-8')

  const { records } = await loadRecords(dir)
  assert.equal(records.length, 1)
  assert.equal(records[0].text, '有效')
})

test('并发追加不丢记录', async () => {
  const dir = await tempDir()
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      appendRecord(dir, {
        id: createRecordId(),
        action: 'add',
        text: `并发 ${index}`,
        ts: new Date(Date.now() + index).toISOString(),
      }),
    ),
  )
  const { records } = await loadRecords(dir)
  assert.equal(records.length, 20)
})

test('高并发写入不被锁饿死', async () => {
  const dir = await tempDir()
  const total = 120
  await Promise.all(
    Array.from({ length: total }, (_, index) =>
      appendRecord(dir, {
        id: createRecordId(),
        action: 'add',
        text: `压力 ${index}`,
        ts: new Date(Date.now() + index).toISOString(),
      }),
    ),
  )
  const { records, lines } = await loadRecords(dir)
  assert.equal(records.length, total)
  assert.equal(lines, total)
})

test('内容尚未写完的活锁不被抢占', async () => {
  const dir = await tempDir()
  const { writeFile } = await import('node:fs/promises')
  const { lockPath } = await import('../lib/store.js')
  // 模拟"已用 wx 创建、内容还没落盘"的瞬间
  await writeFile(lockPath(dir), '', 'utf-8')

  const result = await withLock(dir, async () => 'should-not-run', { retries: 0, ttlMs: 10_000 })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'lock_contention')
})

test('compact 折叠为一行一条', async () => {
  const dir = await tempDir()
  const id = createRecordId()
  await appendRecord(dir, { id, action: 'add', text: 'v1', ts: '2026-11-11T00:00:00Z' })
  await appendRecord(dir, { id, action: 'correct', text: 'v2', ts: '2026-11-11T00:01:00Z' })
  const ids = await compact(dir)

  assert.equal(ids, 1)
  const raw = await readFile(path.join(dir, RECORDS_FILE), 'utf-8')
  assert.equal(raw.trim().split('\n').length, 1)
  const { records } = await loadRecords(dir)
  assert.equal(records[0].text, 'v2')
})

test('锁被持有且未过期时返回 lock_contention', async () => {
  const dir = await tempDir()
  const { writeFile } = await import('node:fs/promises')
  const { lockPath } = await import('../lib/store.js')
  await writeFile(lockPath(dir), JSON.stringify({ pid: 9, acquiredAt: Date.now(), ownerId: 'alive' }), 'utf-8')

  const result = await withLock(dir, async () => 'should-not-run', { retries: 0, ttlMs: 10_000 })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'lock_contention')
})

test('过期锁被抢占', async () => {
  const dir = await tempDir()
  const { writeFile } = await import('node:fs/promises')
  const { lockPath } = await import('../lib/store.js')
  await writeFile(lockPath(dir), JSON.stringify({ pid: 1, acquiredAt: Date.now() - 60_000, ownerId: 'dead' }), 'utf-8')

  const result = await withLock(dir, async () => 'recovered', { ttlMs: 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.value, 'recovered')
})
