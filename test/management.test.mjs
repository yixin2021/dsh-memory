import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { clearRecords, loadRecords, removeRecord } from '../lib/store.js'
import { dispatchManagement } from '../lib/management.js'

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'dsh-mem-manage-'))
}

/** 写若干条 add 记录，返回 id 列表。 */
async function seed(dir, texts) {
  const ids = []
  for (const [index, text] of texts.entries()) {
    const id = `mem_seed_${index}`
    ids.push(id)
    await writeFile(
      path.join(dir, 'records.jsonl'),
      `${JSON.stringify({ id, action: 'add', text, ts: `2026-11-1${index}T00:00:00.000Z` })}\n`,
      { flag: 'a', encoding: 'utf-8' },
    )
  }
  return ids
}

test('removeRecord 追加 delete 事件但从不清空别人', async () => {
  const dir = await tempDir()
  const [first] = await seed(dir, ['保留我', '删掉我'])

  const result = await removeRecord(dir, 'mem_seed_1')
  assert.deepEqual(result, { existed: true, remaining: 1 })

  const { records } = await loadRecords(dir)
  assert.equal(records.length, 1)
  assert.equal(records[0].id, first)
})

test('removeRecord 对不存在的 id 返回 existed=false 且不写行', async () => {
  const dir = await tempDir()
  await seed(dir, ['唯一一条'])
  const before = await readFile(path.join(dir, 'records.jsonl'), 'utf-8')

  const result = await removeRecord(dir, 'mem_missing')
  assert.deepEqual(result, { existed: false, remaining: 1 })
  assert.equal(await readFile(path.join(dir, 'records.jsonl'), 'utf-8'), before)
})

test('clearRecords 原子清空并把条数报出来', async () => {
  const dir = await tempDir()
  await seed(dir, ['一', '二', '三'])

  const cleared = await clearRecords(dir)
  assert.equal(cleared, 3)

  const { records, lines } = await loadRecords(dir)
  assert.equal(records.length, 0)
  assert.equal(lines, 0)
  assert.equal(await readFile(path.join(dir, 'records.jsonl'), 'utf-8'), '')
})

test('clearRecords 在空库上是幂等的', async () => {
  const dir = await tempDir()
  assert.equal(await clearRecords(dir), 0)
  assert.equal(await clearRecords(dir), 0)
})

test('分发 list 透传服务结果', async () => {
  const service = {
    async list() {
      return { records: [{ id: 'a', text: 't' }], store: { dir: '/x', records: 1, lines: 1 } }
    },
  }
  const answer = await dispatchManagement(service, { action: 'list' })
  assert.equal(answer.ok, true)
  assert.equal(answer.records.length, 1)
  assert.equal(answer.store.dir, '/x')
})

test('分发 delete 按 status 折算 ok', async () => {
  const accepted = await dispatchManagement(
    { async remove() { return { status: 'accepted', id: 'a', remaining: 0 } } },
    { action: 'delete', id: 'a' },
  )
  assert.equal(accepted.ok, true)
  assert.equal(accepted.remaining, 0)

  const missing = await dispatchManagement(
    { async remove() { return { status: 'missing', id: 'b', remaining: 2 } } },
    { action: 'delete', id: 'b' },
  )
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 'missing')
})

test('分发 clear 没有确认位时拒绝，且不调用服务', async () => {
  let called = 0
  const service = { async clear() { called += 1; return { status: 'accepted', cleared: 1 } } }

  const refused = await dispatchManagement(service, { action: 'clear' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'confirm-required')
  assert.equal(called, 0)

  const done = await dispatchManagement(service, { action: 'clear', confirm: true })
  assert.equal(done.ok, true)
  assert.equal(done.cleared, 1)
  assert.equal(called, 1)
})

test('分发未知动作返回 unknown-action', async () => {
  const answer = await dispatchManagement({}, { action: 'nuke' })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'unknown-action')
})
