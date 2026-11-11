/**
 * 自有记忆库：append-only JSONL。
 *
 * 为什么不用上游归档格式作为写入载体：归档写入依赖宿主侧的进程内互斥 +
 * 文件锁 + 版本守卫三者协同，外部进程无法参与其互斥，宿主侧会把外部写入判为
 * `same_version` 并静默跳过，同时用当前文件覆盖 `.bak`。因此插件写入独立存储，
 * 格式与归档同构（uid/version/memoryBlock 语义对齐），便于日后人工迁移。
 *
 * 事件溯源：每次 add / correct / delete 追加一行；读取时按 id 折叠为最新态。
 * 行数超过阈值时在锁内压缩重写，避免无限增长。
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/** 记录文件名。 */
export const RECORDS_FILE = 'records.jsonl'
/** 压缩阈值：超过后折叠重写。 */
export const COMPACT_THRESHOLD = 2000
/**
 * 压缩判定的体积下限。
 * 锁内只有"追加 + stat"是 O(1)，只有文件长到这个体积才值得整库读一遍数行数，
 * 否则每次写入都要在锁内全量解析，高并发下会把其他写者全部饿死。
 */
export const COMPACT_MIN_BYTES = 64 * 1024

/** 生成记录 id。 */
export function createRecordId(now = Date.now()) {
  return `mem_${now.toString(36)}_${randomBytes(4).toString('hex')}`
}

/** 锁文件路径。 */
export function lockPath(dir) {
  return path.join(dir, '.records.lock')
}

/**
 * 进程内串行队列（按目录分槽）。
 *
 * 文件锁是排他的，N 个同进程写者抢一把锁时每轮只有 1 个能成功，重试次数只要
 * 小于 N 就必然有人报 lock_contention。宿主的做法是 per-uid 进程内互斥 + 文件锁
 * 双层，这里对齐：进程内先进队列，文件锁只用来防同机其他进程。
 */
const localQueues = new Map()

async function withLocalQueue(key, run) {
  const previous = localQueues.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  localQueues.set(key, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (localQueues.get(key) === tail) localQueues.delete(key)
  }
}

/**
 * 独占文件锁：`wx` 创建 + TTL 过期抢占 + 指数退避重试。
 * 只用于本插件自有目录，语义比主机侧实现更保守（重试耗尽即返回，不无限等待）。
 */
export async function withLock(dir, run, options = {}) {
  const ttlMs = options.ttlMs ?? 10000
  const retries = options.retries ?? 6
  const delayMs = options.delayMs ?? 30
  const maxDelayMs = options.maxDelayMs ?? 250
  const lock = lockPath(dir)
  const ownerId = `${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`
  let wait = delayMs
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ownerId }), {
        flag: 'wx',
        encoding: 'utf-8',
      })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await reclaimable(lock, ttlMs)) continue
      if (attempt === retries) return { ok: false, errorCode: 'lock_contention' }
      // 指数退避 + 抖动：避免多个进程的写者在同一时刻反复对撞。
      await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * (wait / 2))))
      wait = Math.min(wait * 2, maxDelayMs)
      continue
    }
    try {
      return { ok: true, value: await run() }
    } finally {
      await release(lock, ownerId)
    }
  }
  return { ok: false, errorCode: 'lock_contention' }
}

/**
 * 判断当前锁能否立刻重试。
 *
 * 关键点：锁文件是"先创建再写入"的，读到的内容可能是空串或写了一半，
 * 不能据此判定内容损坏并删锁——那会把持有者的活锁抢走，导致两个写者同时进临界区。
 * 只有「拿不到 acquiredAt 且文件 mtime 已超过 TTL」才认定为残留锁。
 */
async function reclaimable(lock, ttlMs) {
  const raw = await fs.readFile(lock, 'utf-8').catch(() => null)
  if (raw === null) return true // 已被释放，立刻重试
  let holder = null
  try {
    holder = JSON.parse(raw)
  } catch {
    holder = null
  }
  if (holder && typeof holder.acquiredAt === 'number') {
    if (Date.now() - holder.acquiredAt <= ttlMs) return false
    await fs.unlink(lock).catch(() => {})
    return true
  }
  const stat = await fs.stat(lock).catch(() => null)
  if (!stat) return true
  if (Date.now() - stat.mtimeMs <= ttlMs) return false
  await fs.unlink(lock).catch(() => {})
  return true
}

async function release(lock, ownerId) {
  try {
    const raw = await fs.readFile(lock, 'utf-8').catch(() => null)
    if (raw) {
      try {
        if (JSON.parse(raw).ownerId !== ownerId) return
      } catch {
        // 内容损坏仍尝试释放
      }
    }
    await fs.unlink(lock).catch(() => {})
  } catch {
    // 释放失败不影响主流程
  }
}

/**
 * 读取并折叠记录。
 * 单行损坏只跳过该行，不让整库不可用。
 */
export async function loadRecords(dir) {
  const file = path.join(dir, RECORDS_FILE)
  let raw
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return { file, records: [], lines: 0 }
  }
  const byId = new Map()
  let lines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    lines += 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record?.id) continue
    if (record.action === 'delete') byId.delete(record.id)
    else byId.set(record.id, record)
  }
  return { file, records: [...byId.values()], lines }
}

/**
 * 追加一条记录（需在锁内调用）。
 * 热路径只有"追加 + stat"；体积越过下限才读全库判断是否需要压缩，
 * 避免锁内做 O(文件大小) 的解析而拖长临界区。
 */
async function appendLocked(dir, record) {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, RECORDS_FILE)
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf-8')
  const { size } = await fs.stat(file)
  if (size >= COMPACT_MIN_BYTES) {
    const current = await loadRecords(dir)
    if (current.lines > COMPACT_THRESHOLD) await compactLocked(dir, current.records)
  }
  return record.id
}

/**
 * 写操作的统一入口：进程内排队 → 抢文件锁 → 执行。
 * 同进程写者只会在内存队列里等，不会互相制造 lock_contention。
 */
async function withStore(dir, run) {
  const locked = await withLocalQueue(path.resolve(dir), () => withLock(dir, run))
  if (!locked.ok) throw Object.assign(new Error('memory store is locked'), { code: 'lock_contention' })
  return locked.value
}

/**
 * 追加一条记录。
 */
export async function appendRecord(dir, record) {
  return withStore(dir, () => appendLocked(dir, record))
}

/**
 * 删除单条记录：追加一条 delete 事件（保持 append-only 语义）。
 * @returns `{ existed, remaining }`
 */
export async function removeRecord(dir, id) {
  return withStore(dir, async () => {
    const { records } = await loadRecords(dir)
    const existed = records.some((record) => record.id === id)
    if (!existed) return { existed: false, remaining: records.length }
    await appendLocked(dir, { id, action: 'delete', ts: new Date().toISOString() })
    return { existed: true, remaining: records.length - 1 }
  })
}

/**
 * 清空整个库：锁内把文件原子重写为空。
 * 不走"逐条追加 delete"，因为清空之后旧事件没有任何价值，重写更小也更快。
 * @returns 被清掉的记录条数
 */
export async function clearRecords(dir) {
  return withStore(dir, async () => {
    const { records } = await loadRecords(dir)
    const file = path.join(dir, RECORDS_FILE)
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tmp, '', 'utf-8')
    await fs.rename(tmp, file)
    return records.length
  })
}

/**
 * 压缩：把折叠后的最新态原子重写为 JSONL。
 * 需在锁内调用；对外暴露 `compact` 供维护命令使用。
 */
export async function compactLocked(dir, records) {
  const file = path.join(dir, RECORDS_FILE)
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  const body = records.map((record) => JSON.stringify({ ...record, action: 'add' })).join('\n')
  await fs.writeFile(tmp, body ? `${body}\n` : '', 'utf-8')
  await fs.rename(tmp, file)
  return records.length
}

/** 供外部维护调用：加锁后压缩。 */
export async function compact(dir) {
  return withStore(dir, async () => {
    const { records } = await loadRecords(dir)
    return compactLocked(dir, records)
  })
}
