/**
 * 记忆文本的脱敏与截断。
 *
 * 复刻主机侧两道防线：绝对路径替换为 `[path omitted]`；按 UTF-16 码元截断且
 * 不切断代理对。写入自有库前先脱敏，避免把本机目录结构带进可被检索的长期记忆。
 */

/** 需要脱敏的路径根前缀。 */
const REDACT_PREFIXES = [
  'Users', 'home', 'Volumes', 'private', 'tmp', 'var', 'mnt', 'media',
  'opt', 'srv', 'root', 'data', 'Applications', 'Library',
]

/** 路径被移除后的占位符。 */
export const PATH_PLACEHOLDER = '[path omitted]'

/**
 * 把绝对路径替换为占位符。
 * @returns `{ text, removedCount }`，`removedCount` 用于在返回体里如实报告改动幅度。
 */
export function redactPaths(text) {
  if (!text) return { text: '', removedCount: 0 }
  let removedCount = 0
  const tail = `(?:[^\\s"'\`,;)\\]}）】，。；]*)`
  const patterns = [
    new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/]${tail}`, 'g'),
    new RegExp(`(?<![\\w/])~/${tail}`, 'g'),
    new RegExp(`(?<![\\w:/~.-])/(?:${REDACT_PREFIXES.join('|')})/${tail}`, 'g'),
  ]
  let result = text
  for (const pattern of patterns) {
    result = result.replace(pattern, () => {
      removedCount += 1
      return PATH_PLACEHOLDER
    })
  }
  return { text: result, removedCount }
}

/** 按 UTF-16 码元截断，不切断代理对。 */
export function truncateUtf16(text, limit) {
  if (!text || limit <= 0) return ''
  if (text.length <= limit) return text
  let end = limit
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return end <= 0 ? '' : text.slice(0, end)
}

/** 敏感值快速判定：命中常见密钥形态即拒绝写入。 */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

/**
 * 是否疑似密钥。
 * 只做形态匹配：宁可误拒一次，也不把凭证写进长期记忆。
 */
export function looksLikeSecret(text) {
  if (!text) return false
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}
