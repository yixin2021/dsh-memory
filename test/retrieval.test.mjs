import assert from 'node:assert/strict'
import test from 'node:test'

import { rankRecords, scoreRecord, tokenize } from '../lib/retrieval.js'

test('中文按二元组切分，英文按词切分', () => {
  const tokens = tokenize('记忆系统 Memory Plugin')
  assert.ok(tokens.has('记忆'))
  assert.ok(tokens.has('忆系'))
  assert.ok(tokens.has('memory'))
  assert.ok(tokens.has('plugin'))
  assert.ok(!tokens.has('记'), '单字不进入检索词')
})

test('完全命中的记录得分高于部分命中', () => {
  const query = tokenize('branch naming')
  const full = scoreRecord({ text: 'branch naming 规则：feature/xxx' }, query)
  const partial = scoreRecord({ text: 'branch 管理' }, query)
  assert.ok(full > partial)
  assert.ok(partial > 0)
})

test('无交集记录得分为 0 并被排除', () => {
  const records = [
    { id: 'a', text: '关于数据库索引的经验' },
    { id: 'b', text: '用户偏好 TypeScript 严格模式' },
  ]
  const ranked = rankRecords(records, 'TypeScript', 5)
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].id, 'b')
  assert.equal(scoreRecord(records[0], tokenize('TypeScript')), 0)
})

test('同分时新记录优先', () => {
  const records = [
    { id: 'old', text: 'pnpm 安装约定', ts: '2026-01-01T00:00:00Z' },
    { id: 'new', text: 'pnpm 安装约定', ts: '2026-06-01T00:00:00Z' },
  ]
  const ranked = rankRecords(records, 'pnpm', 5)
  assert.deepEqual(ranked.map((record) => record.id), ['new', 'old'])
})

test('limit 生效且空查询返回空数组', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, text: `记忆 ${index} 条` }))
  assert.equal(rankRecords(records, '记忆', 3).length, 3)
  assert.deepEqual(rankRecords(records, '', 3), [])
})

test('缺 text 字段的记录被跳过', () => {
  assert.deepEqual(rankRecords([{ id: 'x' }], '记忆', 3), [])
})
