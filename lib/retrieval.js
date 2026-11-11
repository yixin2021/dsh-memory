/**
 * 召回排序：无需向量库的关键词打分。
 *
 * 设计取向与主机侧一致——`<memory_index>` 只是检索提示而非证据，因此召回只返回
 * 命中的少量条目，而不是把整块画像倒进上下文。中文按二元组切分，英文按词切分，
 * 打分用"查询词覆盖率 × 词频增益"，避免长文本靠长度取胜。
 */

/** 抽取检索词：英文词 + 中文二元组。 */
export function tokenize(text) {
  if (!text) return new Set()
  const lower = String(text).toLowerCase()
  const latin = lower.match(/[a-z0-9_.#+/:-]{2,}/g) ?? []
  const cjk = lower.match(/[\u4e00-\u9fff]/g) ?? []
  const tokens = new Set(latin)
  for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk[i] + cjk[i + 1])
  return tokens
}

/**
 * 单条记录的打分。
 * 覆盖率为主项，词频取对数增益，避免同一词重复堆叠刷分。
 */
export function scoreRecord(record, queryTokens) {
  if (queryTokens.size === 0) return 0
  const haystack = `${record.text ?? ''} ${record.scope ?? ''}`
  const recordTokens = tokenize(haystack)
  let matched = 0
  let occurrences = 0
  for (const token of queryTokens) {
    if (!recordTokens.has(token)) continue
    matched += 1
    const hits = haystack.toLowerCase().split(token).length - 1
    occurrences += Math.log(1 + hits)
  }
  if (matched === 0) return 0
  return Number(((matched / queryTokens.size) + 0.1 * occurrences).toFixed(4))
}

/**
 * 排序并截断。
 * 同分时新记录优先——记忆的价值随时间衰减，这条规则让纠错条目更容易被取到。
 */
export function rankRecords(records, query, limit = 8) {
  const tokens = tokenize(query)
  const scored = records
    .filter((record) => typeof record.text === 'string' && record.text.length > 0)
    .map((record) => ({ ...record, score: scoreRecord(record, tokens) }))
    .filter((record) => record.score > 0)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.ts ?? '').localeCompare(String(a.ts ?? ''))
  })
  return scored.slice(0, Math.max(0, limit))
}
