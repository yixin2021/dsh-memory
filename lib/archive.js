/**
 * 上游记忆归档的读取与格式兼容层。
 *
 * 格式与上游宿主侧的记忆归档完全一致：Markdown 外壳 + HTML 注释内的权威 JSON。
 * 序列化沿用 `JSON.stringify(profile, null, 2)` 的全字段写法，因此 `memoryIndex`
 * 等附加字段不会在往返中丢失。
 *
 * 本模块只读。写入上游归档会与其进程内互斥、文件锁、版本守卫三者冲突，
 * 上游会把外部写入判为 `same_version` 静默跳过，并覆盖 `.bak` 备份。
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 主归档后缀。 */
export const PROFILE_SUFFIX = '_memory.md'
/** legacy 归档后缀（上游历史拼写错误，保留以兼容）。 */
export const LEGACY_PROFILE_SUFFIX = '_memery.md'

/**
 * 上游数据目录名。
 *
 * 这是磁盘上的真实目录名，全包仅此一处保留该字面量——它就是要读的路径，
 * 换成别的值就读不到已有归档。需要指向别处时，用 `archiveRoot` 配置或
 * 环境变量 `DSH_MEMORY_ARCHIVE_ROOT` 覆盖，不必改这里。
 */
export const UPSTREAM_FOLDER_NAME = '.workbuddy'

/** 归档 JSON 块的分隔标记。 */
const RAW_START = '<!-- RAW_JSON_START'
const RAW_END = 'RAW_JSON_END -->'

/** 文件名净化，与上游 sanitizeFilename 等价。 */
export function sanitizeFilename(input) {
  return String(input ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
}

/** 序列化为归档 Markdown。全字段写入，保持与上游一致。 */
export function serializeProfile(profile) {
  const normalized = { ...profile, updatedAt: profile.updatedAt ?? new Date().toISOString() }
  if (normalized.version === undefined) normalized.version = 0
  if (normalized.memoryBlock === undefined) normalized.memoryBlock = ''
  return [
    '# User Memory Profile',
    `> Last updated: ${normalized.updatedAt}`,
    `> Version: ${normalized.version}`,
    '',
    '## Memory Block',
    '',
    normalized.memoryBlock,
    '',
    '---',
    '',
    RAW_START,
    JSON.stringify(normalized, null, 2),
    RAW_END,
    '',
  ].join('\n')
}

/**
 * 解析归档 Markdown。
 * 先取 RAW_JSON；损坏时回退到头部与正文的正则解析（与上游同策略）。
 * uid 不匹配不报错，以请求 uid 覆盖——上游同样如此，故文件内 uid 不可作身份校验。
 */
export function parseProfile(markdown, uid) {
  const start = markdown.indexOf(RAW_START)
  if (start !== -1) {
    const bodyStart = markdown.indexOf('\n', start)
    const end = markdown.indexOf(RAW_END, bodyStart)
    if (bodyStart !== -1 && end !== -1) {
      try {
        const parsed = JSON.parse(markdown.slice(bodyStart + 1, end).trim())
        return parsed.uid === uid ? parsed : { ...parsed, uid }
      } catch {
        // 落到正则降级路径
      }
    }
  }
  const version = /^>\s*Version:\s*(\d+)/m.exec(markdown)
  const updatedAt = /^>\s*Last updated:\s*(.+)$/m.exec(markdown)
  const block = /## Memory Block\n\n([\s\S]*?)\n\n---/.exec(markdown)
  return {
    uid,
    memoryBlock: block?.[1]?.trim() ?? '',
    version: version ? Number.parseInt(version[1], 10) : undefined,
    updatedAt: updatedAt?.[1]?.trim() ?? undefined,
  }
}

/**
 * 上游数据根目录。
 *
 * 优先级：`archiveRoot` 配置 → `DSH_MEMORY_ARCHIVE_ROOT` → `~/.workbuddy`。
 *
 * @param options - `{ archiveRoot?, homeDir? }`。
 * @returns 绝对目录路径。
 */
export function resolveArchiveRoot(options = {}) {
  const override = options.archiveRoot?.trim() || process.env.DSH_MEMORY_ARCHIVE_ROOT?.trim()
  if (override) return override
  const home = options.homeDir?.trim() || homedir()
  return path.join(home, UPSTREAM_FOLDER_NAME)
}

/**
 * 归档候选路径，按优先级返回。
 * 平台化目录优先于扁平目录；legacy 目录（memery）最后兜底。
 */
export function resolveArchiveCandidates(options = {}) {
  const uid = options.uid
  if (!uid) return []
  const root = resolveArchiveRoot(options)
  const name = sanitizeFilename(uid)
  const scope = sanitizeFilename(options.enterpriseId?.trim() || 'personal')
  return [
    path.join(root, 'memory', 'platform', scope, `${name}${PROFILE_SUFFIX}`),
    path.join(root, 'memory', `${name}${PROFILE_SUFFIX}`),
    path.join(root, 'memery', `${name}${LEGACY_PROFILE_SUFFIX}`),
  ]
}

/**
 * 读取最新的归档文件。
 * 多候选时按 mtime 取最新，避免平台化迁移期间读到旧副本。
 */
export async function readArchive(options = {}) {
  const candidates = resolveArchiveCandidates(options)
  let newest
  for (const file of candidates) {
    try {
      const stat = await fs.stat(file)
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs }
    } catch {
      // 候选不存在
    }
  }
  if (!newest) return undefined
  const markdown = await fs.readFile(newest.file, 'utf-8')
  return {
    file: newest.file,
    bytes: Buffer.byteLength(markdown, 'utf-8'),
    markdown,
    profile: parseProfile(markdown, options.uid),
  }
}

/** 用户级 persona 目录：`user-<uid>-<personal|enterpriseId>`。 */
export function resolveUserDir(options = {}) {
  const uid = options.uid
  if (!uid) return undefined
  const root = resolveArchiveRoot(options)
  const scope = sanitizeFilename(options.enterpriseId?.trim() || 'personal')
  return path.join(root, `user-${sanitizeFilename(uid)}-${scope}`)
}

/** 读取用户级 MEMORY.md（跨项目长期偏好）。 */
export async function readUserMemory(options = {}) {
  const dir = resolveUserDir(options)
  if (!dir) return undefined
  const file = path.join(dir, 'MEMORY.md')
  try {
    const text = (await fs.readFile(file, 'utf-8')).trim()
    return text ? { file, text } : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取工作区记忆：`<workspace>/<folder>/memory/MEMORY.md` 与最近一篇日誌。
 * 上游日誌按 `YYYY-MM-DD.md` 命名且只追加，这里取文件名排序最大者。
 *
 * @param workspaceDir - 工作区根目录。
 * @param options - `{ folderName? }`，目录名默认取 `UPSTREAM_FOLDER_NAME`。
 */
export async function readWorkspaceMemory(workspaceDir, options = {}) {
  if (!workspaceDir) return undefined
  const folder = options.folderName?.trim() || process.env.DSH_MEMORY_WORKSPACE_FOLDER?.trim() || UPSTREAM_FOLDER_NAME
  const dir = path.join(workspaceDir, folder, 'memory')
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const daily = entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .pop()
  const result = { dir }
  try {
    const text = (await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf-8')).trim()
    if (text) result.instructions = text
  } catch {
    // 无项目说明文件
  }
  if (daily) {
    try {
      result.latestDaily = { name: daily, text: (await fs.readFile(path.join(dir, daily), 'utf-8')).trim() }
    } catch {
      // 日誌读取失败不影响其余字段
    }
  }
  return Object.keys(result).length > 1 ? result : undefined
}
