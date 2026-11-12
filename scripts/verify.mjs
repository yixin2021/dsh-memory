#!/usr/bin/env node
/**
 * dsh-memory 健康检查。
 *
 * 回答一个问题：记忆现在到底生效到哪一步了。
 *
 * 默认全只读——只读磁盘上的库，不改一个字节。
 * 加 `--selftest` 时会在临时目录里跑一次「写入 → 召回 → 清空」的闭环，
 * 用真实代码路径证明引擎本身可用（全程不碰你自己的库）。
 *
 * 用法：
 *   npm run verify            # 只检查现状
 *   npm run verify -- --selftest
 */

import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { rankRecords } from '../lib/retrieval.js'
import { appendRecord, clearRecords, loadRecords } from '../lib/store.js'

const dataDir = process.env.DSH_MEMORY_DATA_DIR?.trim() || path.join(homedir(), '.dsh-memory')
const selftest = process.argv.includes('--selftest')

const ok = []
const warn = []
const fail = []

/** 输出一行带标记的检查结果。 */
function line(mark, label, detail) {
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** 截断长文本，避免刷屏。 */
function clip(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

console.log('dsh-memory 健康检查')
console.log(`库目录: ${dataDir}`)
console.log('─'.repeat(60))

// 1) 自有库现状
const { file, records, lines } = await loadRecords(dataDir)
console.log('\n[1] 自有记忆库')
if (lines === 0) {
  line('○', '库为空', `${file} 还没有任何记录`)
  warn.push('库为空是正常的——说明还没让助手动过「记住」。')
} else {
  line('✓', '读到记录', `${records.length} 条有效 / ${lines} 行事件`)
  ok.push('库可读')
  const recent = records
    .slice()
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
    .slice(0, 3)
  for (const record of recent) {
    console.log(`    ${record.ts ?? '?'}  ${record.scope ? `[${record.scope}] ` : ''}${clip(record.text)}`)
  }
  if (records.length < lines) {
    line('·', '事件折叠生效', `${lines} 行里 ${lines - records.length} 行是 delete/覆盖事件`)
  }
}

// 2) 召回能力（用库里的真实数据试一次）
console.log('\n[2] 召回（关键词检索）')
if (records.length === 0) {
  line('○', '跳过', '库里没有条目可检索')
} else {
  const probe = clip(records[records.length - 1].text, 20)
  const hits = rankRecords(records, probe, 3)
  if (hits.length > 0 && hits[0].score > 0) {
    line('✓', '召回命中', `用「${probe}」查到 ${hits.length} 条，最高分 ${hits[0].score.toFixed(3)}`)
    ok.push('召回可用')
  } else {
    line('✗', '召回无命中', `用「${probe}」没查到任何条目`)
    fail.push('召回异常：库里有数据但检索不到')
  }
}

// 3) 端到端自检（临时目录，不碰真实库）
if (selftest) {
  console.log('\n[3] 写入 → 召回 → 清空 闭环（临时目录）')
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-memory-verify-'))
  try {
    const id = await appendRecord(dir, { id: 'mem_selftest', action: 'add', text: '自检：偏好简洁的中文技术回答' })
    const after = await loadRecords(dir)
    const hits = rankRecords(after.records, '中文技术回答怎么讲', 3)
    const cleared = await clearRecords(dir)
    const empty = await loadRecords(dir)

    const wrote = after.records.length === 1 && id === 'mem_selftest'
    const recalled = hits.length > 0 && hits[0].id === 'mem_selftest'
    const clearedOk = empty.records.length === 0 && cleared >= 1

    line(wrote ? '✓' : '✗', '写入', wrote ? '记录落盘并可读回' : '写入后读不到')
    line(recalled ? '✓' : '✗', '召回', recalled ? `命中 ${hits[0].id}，分数 ${hits[0].score.toFixed(3)}` : '写入的内容检索不到')
    line(clearedOk ? '✓' : '✗', '清空', clearedOk ? `回收 ${cleared} 条，库已空` : '清空后仍有残留')
    if (wrote && recalled && clearedOk) ok.push('端到端闭环通过')
    else fail.push('端到端闭环失败：写入/召回/清空至少一环不通过。')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// 4) 结论
console.log(`\n${'─'.repeat(60)}`)
if (fail.length === 0) {
  console.log(`结论：插件工作正常${warn.length ? `（${warn.length} 项提示见下）` : ''}。`)
} else {
  console.log('结论：发现问题。')
}
for (const item of warn) console.log(`  · ${item}`)
for (const item of fail) console.log(`  ✗ ${item}`)

if (!selftest) console.log('\n提示：加 --selftest 可跑一次真实的写入→召回→清空闭环。')
process.exitCode = fail.length === 0 ? 0 : 1
