/**
 * dsh-memory — 跨会话长期记忆插件。
 *
 * 三个来源、一个写入出口：
 * - 读：上游记忆归档（只读镜像，兼容两种目录布局与 legacy 拼写）
 * - 读：上游工作区记忆（MEMORY.md + 最近日誌）
 * - 读/写：本插件自有 append-only 库（JSONL，锁内追加，超阈值折叠压缩）
 *
 * 工具语义对齐上游宿主的 `MemoryRecall` / `MemoryUpdate`，因此同一套提示词策略可以
 * 在两个宿主之间平移；`ctx.provide('memory')` 让其他插件无需重复注册工具。
 *
 * @module dsh-memory
 */

import { homedir } from 'node:os'
import path from 'node:path'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { readArchive, readUserMemory, readWorkspaceMemory } from './lib/archive.js'
import { dispatchManagement } from './lib/management.js'
import { looksLikeSecret, redactPaths, truncateUtf16 } from './lib/redact.js'
import { rankRecords } from './lib/retrieval.js'
import { appendRecord, clearRecords, createRecordId, loadRecords, removeRecord } from './lib/store.js'

/** 客户端（设置页）调用的路由。 */
export const ROUTE = '/api/dsh-memory'

/** 插件名。 */
export const name = 'memory'

/** 依赖的服务：提示词装配与工具注册表。 */
export const inject = ['systemPrompt', 'tools']

/** 单条记忆的字符上限。 */
const MAX_ENTRY_CHARS = 4000

/** 提示词段落：策略文案与主机侧保持同一套边界。 */
const GUIDANCE = `# Memory

A persistent memory service is mounted on this session. Use it for durable facts,
preferences, standing conventions and verified lessons — never for transient state.

**Recall**
- Call \`memory_recall\` before an answer that depends on private prior context: earlier
  decisions, user preferences, incidents, conventions, or how a past task was resolved.
- Skip self-contained requests, and skip anything already present in the conversation,
  in project files, or in injected workspace notes.
- Recalled memory is background. Current user input and the verified current state of
  files take precedence; memory never establishes what a file or task looks like now.
- If recall returns nothing, continue when the task is still completable and ask only
  for what actually blocks correctness.

**Update**
- Before the final reply of substantive work, submit durable and verified facts once.
- On an explicit request ("remember this", "from now on", "forget about X"), write in
  that turn without asking the user to confirm.
- Each distinct insight is submitted once. Corrections name the entry id returned by a
  previous recall or update; deletions require that id.
- Skip guesses, raw tool output, logs, generic public knowledge and duplicates.

**Boundaries**
- Never store credentials, tokens, keys or private keys; a refused secret is reported,
  not silently dropped.
- Absolute paths are replaced with \`[path omitted]\` before storage; keep entries
  self-contained without machine-specific paths.
- Project instruction files and the user profile are edited only when the user explicitly
  asks for those records; a plain request to remember uses the memory tools.
- Accepted means submitted, not indexed: report the returned status and do not re-recall
  to verify.`

/** 插件配置。 */
export const Config = z.object({
  /** `mirror` 额外读取上游归档与工作区记忆；`standalone` 只用自有库。 */
  readMode: z.union([z.const('mirror'), z.const('standalone')]).default('mirror'),
  /** 上游账号 uid，决定归档文件名；留空则不镜像。 */
  uid: z.string().default(''),
  /** 企业作用域，决定 `memory/platform/<scope>/` 子目录。 */
  enterpriseId: z.string().default(''),
  /** 上游数据根目录；留空用内置默认目录。 */
  archiveRoot: z.string().default(''),
  /** 工作区里的上游数据目录名；留空用内置默认值。 */
  workspaceFolder: z.string().default(''),
  /** 工作区根目录；留空取进程工作目录。 */
  workspace: z.string().default(''),
  /** 自有记忆库目录。 */
  dataDir: z.string().default(''),
  /** 单次召回条目上限。 */
  recallLimit: z.natural().default(8),
  /** 是否在召回结果里附带归档画像摘要。 */
  injectProfile: z.boolean().default(true),
  /** 画像摘要字符上限。 */
  injectLimit: z.natural().default(4000),
})

/**
 * 召回工具的输出契约。
 * 注意：dsh 的 value schema DSL 用"属性级 `required: true`"，不接受 `required: []`，
 * 且对象默认开放；这里显式关闭 `additionalProperties` 以免多写字段被静默忽略。
 */
const RECALL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      trace_id: { type: 'string', required: true },
      query: { type: 'string', required: true },
      hits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            text: { type: 'string', required: true },
            score: { type: 'number', required: true },
            scope: { type: 'string' },
            ts: { type: 'string' },
          },
        },
      },
      archive: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          version: { type: 'integer' },
          updatedAt: { type: 'string' },
          blockChars: { type: 'integer', required: true },
        },
      },
      workspace: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true },
          latestDaily: { type: 'string' },
        },
      },
      profileExcerpt: { type: 'string' },
      note: { type: 'string' },
    },
  },
  render: renderJson,
}

/** 更新工具的输出契约。 */
const UPDATE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      trace_id: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: ['accepted', 'rejected', 'failed'] },
      id: { type: 'string' },
      redactedPaths: { type: 'integer' },
      truncated: { type: 'boolean' },
      errorCode: { type: 'string' },
      message: { type: 'string' },
    },
  },
  render: renderJson,
}

/** 画像查询工具的输出契约。 */
const PROFILE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      available: { type: 'boolean', required: true },
      file: { type: 'string' },
      uid: { type: 'string' },
      version: { type: 'integer' },
      updatedAt: { type: 'string' },
      bytes: { type: 'integer' },
      blockChars: { type: 'integer' },
      store: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true },
          records: { type: 'integer', required: true },
          lines: { type: 'integer', required: true },
        },
      },
      note: { type: 'string' },
    },
  },
  render: renderJson,
}

/** 统一的 JSON 渲染。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 生成一次操作的关联 id。 */
function createTraceId() {
  return Math.random().toString(16).slice(2, 10)
}

/** 解析配置默认值。 */
function resolveConfig(config) {
  const dataDir = config.dataDir?.trim() || path.join(homedir(), '.dsh-memory')
  return {
    readMode: config.readMode ?? 'mirror',
    uid: config.uid?.trim() ?? '',
    enterpriseId: config.enterpriseId?.trim() ?? '',
    archiveRoot: config.archiveRoot?.trim() ?? '',
    workspaceFolder: config.workspaceFolder?.trim() ?? '',
    workspace: config.workspace?.trim() || process.cwd(),
    dataDir,
    recallLimit: Math.min(Math.max(config.recallLimit ?? 8, 1), 50),
    injectProfile: config.injectProfile !== false,
    injectLimit: Math.max(config.injectLimit ?? 4000, 200),
  }
}

/**
 * 构造记忆服务。
 * 与工具分离，便于其他插件直接 `ctx.get('memory')` 复用。
 */
export function createMemoryService(config) {
  const resolved = resolveConfig(config)

  return {
    /** 归档 + 用户画像 + 工作区记忆，全部只读。 */
    async inspect() {
      if (resolved.readMode === 'standalone') return {}
      const scope = {
        uid: resolved.uid,
        enterpriseId: resolved.enterpriseId,
        ...(resolved.archiveRoot ? { archiveRoot: resolved.archiveRoot } : {}),
      }
      const [archive, userMemory, workspace] = await Promise.all([
        resolved.uid ? readArchive(scope) : undefined,
        resolved.uid ? readUserMemory(scope) : undefined,
        readWorkspaceMemory(resolved.workspace, { folderName: resolved.workspaceFolder }),
      ])
      return { archive, userMemory, workspace }
    },

    /** 召回：自有库排序 + 归档画像摘要。 */
    async recall(query, options = {}) {
      const traceId = options.traceId ?? createTraceId()
      const limit = Math.min(options.limit ?? resolved.recallLimit, 50)
      const { records } = await loadRecords(resolved.dataDir)
      const hits = rankRecords(records, query, limit).map((record) => ({
        id: record.id,
        text: record.text,
        ...(record.scope ? { scope: record.scope } : {}),
        ...(record.ts ? { ts: record.ts } : {}),
        score: record.score,
      }))

      const result = { trace_id: traceId, query, hits }
      const seen = await this.inspect()

      if (seen.archive) {
        result.archive = {
          file: seen.archive.file,
          ...(typeof seen.archive.profile.version === 'number' ? { version: seen.archive.profile.version } : {}),
          ...(seen.archive.profile.updatedAt ? { updatedAt: seen.archive.profile.updatedAt } : {}),
          blockChars: (seen.archive.profile.memoryBlock ?? '').length,
        }
        if (resolved.injectProfile && seen.archive.profile.memoryBlock) {
          result.profileExcerpt = truncateUtf16(seen.archive.profile.memoryBlock, resolved.injectLimit)
        }
      }
      if (seen.workspace) {
        result.workspace = {
          dir: seen.workspace.dir,
          ...(seen.workspace.latestDaily ? { latestDaily: seen.workspace.latestDaily.name } : {}),
        }
      }
      if (hits.length === 0) {
        result.note = seen.archive
          ? 'No entry in the local store matched; the archive above only reports its size and version.'
          : 'No entry in the local store matched, and no archive is mirrored (uid unset or standalone mode).'
      }
      return result
    },

    /** 写入：add / correct / delete。 */
    async update(input) {
      const traceId = input.traceId ?? createTraceId()
      const action = input.action ?? 'add'
      if (!['add', 'correct', 'delete'].includes(action)) {
        return { trace_id: traceId, status: 'rejected', errorCode: 'unknown_action' }
      }
      if (action === 'delete') {
        if (!input.id) return { trace_id: traceId, status: 'rejected', errorCode: 'missing_id' }
        await appendRecord(resolved.dataDir, {
          id: input.id,
          action: 'delete',
          ts: new Date().toISOString(),
        })
        return { trace_id: traceId, status: 'accepted', id: input.id }
      }

      const raw = (input.text ?? '').trim()
      if (!raw) return { trace_id: traceId, status: 'rejected', errorCode: 'empty_text' }
      if (looksLikeSecret(raw)) {
        return {
          trace_id: traceId,
          status: 'rejected',
          errorCode: 'secret_detected',
          message: 'Looks like a credential; it was not stored. Store a reference to where it lives instead.',
        }
      }

      const { text: redacted, removedCount } = redactPaths(raw)
      const truncated = redacted.length > MAX_ENTRY_CHARS
      const record = {
        id: action === 'correct' && input.id ? input.id : createRecordId(),
        action,
        text: truncated ? truncateUtf16(redacted, MAX_ENTRY_CHARS) : redacted,
        ...(input.scope ? { scope: String(input.scope).slice(0, 120) } : {}),
        redactedPaths: removedCount,
        ts: new Date().toISOString(),
      }
      try {
        await appendRecord(resolved.dataDir, record)
      } catch (error) {
        return {
          trace_id: traceId,
          status: 'failed',
          errorCode: error?.code ?? 'io_error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      return {
        trace_id: traceId,
        status: 'accepted',
        id: record.id,
        ...(removedCount ? { redactedPaths: removedCount } : {}),
        ...(truncated ? { truncated: true } : {}),
      }
    },

    /** 自检：归档元信息 + 自有库规模。 */
    async profile() {
      const seen = await this.inspect()
      const { records, lines, file } = await loadRecords(resolved.dataDir)
      if (!seen.archive) {
        return {
          available: false,
          store: { dir: resolved.dataDir, records: records.length, lines },
          note: resolved.uid
            ? 'No archive found for this uid; check readMode, archiveRoot and the archive directory.'
            : 'uid is unset, so no archive is mirrored. Set uid to read one.',
        }
      }
      return {
        available: true,
        file: seen.archive.file,
        ...(seen.archive.profile.uid ? { uid: seen.archive.profile.uid } : {}),
        ...(typeof seen.archive.profile.version === 'number' ? { version: seen.archive.profile.version } : {}),
        ...(seen.archive.profile.updatedAt ? { updatedAt: seen.archive.profile.updatedAt } : {}),
        bytes: seen.archive.bytes,
        blockChars: (seen.archive.profile.memoryBlock ?? '').length,
        store: { dir: resolved.dataDir, records: records.length, lines },
        note: `archive is read-only; writes go to ${path.basename(file)} in the store above`,
      }
    },

    /**
     * 设置页：列出全部自有记忆（按时间倒序）与只读镜像的元信息。
     */
    async list() {
      const { records, lines, file } = await loadRecords(resolved.dataDir)
      const sorted = [...records].sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
      const seen = await this.inspect()
      return {
        records: sorted.map((record) => ({
          id: record.id,
          text: record.text,
          ...(record.scope ? { scope: record.scope } : {}),
          ...(record.ts ? { ts: record.ts } : {}),
        })),
        store: { dir: resolved.dataDir, file, records: records.length, lines },
        ...(seen.archive
          ? {
              archive: {
                file: seen.archive.file,
                ...(typeof seen.archive.profile.version === 'number' ? { version: seen.archive.profile.version } : {}),
                ...(seen.archive.profile.updatedAt ? { updatedAt: seen.archive.profile.updatedAt } : {}),
                blockChars: (seen.archive.profile.memoryBlock ?? '').length,
              },
            }
          : {}),
      }
    },

    /**
     * 设置页：删除单条记录。
     * @param id - 记录 id。
     */
    async remove(id) {
      const target = String(id ?? '').trim()
      if (!target) return { status: 'rejected', errorCode: 'missing_id' }
      try {
        const result = await removeRecord(resolved.dataDir, target)
        return {
          status: result.existed ? 'accepted' : 'missing',
          id: target,
          remaining: result.remaining,
        }
      } catch (error) {
        return {
          status: 'failed',
          errorCode: error?.code ?? 'io_error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },

    /**
     * 设置页：清空整个库。
     * 只清自有库；上游归档是外部数据，且本插件对它只读。
     */
    async clear() {
      try {
        const cleared = await clearRecords(resolved.dataDir)
        return { status: 'accepted', cleared }
      } catch (error) {
        return {
          status: 'failed',
          errorCode: error?.code ?? 'io_error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/**
 * 挂载插件。
 * @param ctx - 宿主上下文。
 * @param config - 已按 Config 校验的配置。
 */
export function apply(ctx, config) {
  const service = createMemoryService(config ?? {})
  ctx.provide('memory', service)

  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: resolveSectionOrder(ctx),
    text: GUIDANCE,
  })

  ctx.tools.register(
    defineTool({
      name: 'memory_recall',
      description:
        'Retrieve durable prior knowledge (preferences, decisions, verified lessons) from persistent memory. Call only when the answer depends on private context that is not already in the conversation or in project files.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Self-contained natural-language description of the missing context.',
        },
        limit: { type: 'number', description: 'Maximum number of entries to return.' },
      },
      output: RECALL_OUTPUT,
      execute(args) {
        return service.recall(args.query ?? '', { limit: args.limit })
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Recall memory',
        kind: 'read',
        ...(typeof args?.query === 'string' ? { rawInput: args.query } : {}),
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_update',
      description:
        'Submit a durable fact, correction, or deletion to persistent memory. Submit each distinct insight once. Never submit credentials.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['add', 'correct', 'delete'],
          description: 'add a new entry, correct an existing one by id, or delete by id.',
        },
        text: { type: 'string', description: 'Self-contained statement; required unless action is delete.' },
        id: { type: 'string', description: 'Target entry id for correct or delete.' },
        scope: { type: 'string', description: 'Optional project or domain scope name.' },
      },
      output: UPDATE_OUTPUT,
      execute(args) {
        return service.update(args ?? {})
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Memory ${typeof args?.action === 'string' ? args.action : 'add'}`,
        kind: 'other',
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_profile',
      description:
        'Inspect the mirrored upstream memory archive and the local store size. Read-only; use it before reporting memory state instead of guessing.',
      parameters: {},
      output: PROFILE_OUTPUT,
      execute() {
        return service.profile()
      },
      presentCall: () => ({ card: 'generic', title: 'Inspect memory', kind: 'read' }),
    }),
  )

  mountManagementRoute(ctx, service)

  return service
}

/**
 * 设置页的动作分发见 `lib/management.js`；这里只做路由挂载。
 *
 * 只在宿主真的提供 `connection`（桌面 / 网页）时安装；无头宿主上没有设置页可调，
 * 但插件本身照常可用，所以这里用可选注入而不是写进 `inject`。
 *
 * @param ctx - 宿主上下文。
 * @param service - 记忆服务。
 */
function mountManagementRoute(ctx, service) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (scoped) => {
    scoped.effect(
      () =>
        scoped.connection.fetch.register({
          path: ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body
            try {
              body = await request.json()
            } catch {
              return Response.json(
                { ok: false, code: 'bad-request', message: 'The body is not JSON.' },
                { status: 400 },
              )
            }
            try {
              return Response.json(await dispatchManagement(service, body), {
                headers: { 'cache-control': 'no-store' },
              })
            } catch (error) {
              return Response.json(
                { ok: false, code: 'handler-error', message: error instanceof Error ? error.message : String(error) },
                { status: 500 },
              )
            }
          },
        }),
      'dsh-memory: settings route',
    )
  })
}

/**
 * 取提示词段落排序。
 * `TOOL_MEMORY` 未必在宿主的中心化排序表里，取不到时回退固定值，
 * 让插件在不认识的宿主版本上也能挂载。
 */
function resolveSectionOrder(ctx) {
  try {
    const order = ctx.systemPrompt.getSectionOrder?.('TOOL_MEMORY')
    return typeof order === 'number' ? order : 500
  } catch {
    return 500
  }
}

/** 导出内部构造器供测试使用；不属于插件对外契约。 */
export const internals = { resolveConfig, MAX_ENTRY_CHARS }
