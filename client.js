/**
 * dsh-memory — 客户端那一半（设置页）。
 *
 * 一个面：设置面板里的「记忆」分区，列出本插件自己存下来的记忆，支持刷新、
 * 单条删除和整库清空。上游归档只展示元信息——那是外部应用的数据，
 * 本插件对它只读，界面上也不提供任何清除入口。
 *
 * 页面不碰文件系统：所有事实都来自本包的 Host 路由 `api/dsh-memory`，
 * 浏览器侧没有读写权限。
 *
 * 两个刻意的约束（与同目录 dsh-skills 一致，都来自踩过的坑）：
 *   - 不注册 `locale` 选项：注入的 `t` 座位只对合并进 `LocaleNamespaceMap`
 *     的命名空间存在，第三方插件不是，所以自己绑字典。
 *   - 不用 `useSyncExternalStore`：`useState` + `useEffect` 在任何 React 版本上
 *     都能跑；渲染抛错时兜底显示错误，而不是留一片空白。
 *
 * @module dsh-memory/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 路由，相对页面 origin（支持部署在路径前缀下）。 */
    const ROUTE = 'api/dsh-memory'

    /** 设置导航里的分区 id，和图标共享。 */
    const SECTION_ID = 'memory'

    /** @type {Record<string, string>} */
    const EN = {
      'title': 'Memory',
      'subtitle.empty': 'Nothing stored yet.',
      'subtitle.count': '{count} entries · stored in {dir}',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.clear': 'Clear all',
      'action.delete': 'Delete',
      'action.cancel': 'Cancel',
      'action.confirm': 'Delete forever',
      'confirm.title': 'Delete all {count} entries?',
      'confirm.body': 'This empties the store file and cannot be undone. The upstream archive is not touched.',
      'empty.title': 'No memories yet',
      'empty.body': 'Ask the assistant to remember something in a conversation, then come back here.',
      'row.deleted': 'Deleting…',
      'archive.title': 'Upstream archive · read-only',
      'archive.meta': 'version {version} · {chars} profile characters',
      'archive.note': 'Mirrored from an upstream app and never written to by this plugin, so it cannot be cleared here.',
      'archive.absent': 'No upstream archive is mirrored (uid unset or standalone mode).',
      'error.load': 'Could not read the store:',
      'error.render': 'This section failed to render:',
      'loading': 'Reading memory…',
    }

    /** @type {Record<string, string>} */
    const ZH = {
      'title': '记忆',
      'subtitle.empty': '还没有存储任何记忆。',
      'subtitle.count': '{count} 条记忆 · 存于 {dir}',
      'action.refresh': '刷新',
      'action.refreshing': '读取中…',
      'action.clear': '清空全部',
      'action.delete': '删除',
      'action.cancel': '取消',
      'action.confirm': '永久删除',
      'confirm.title': '删除全部 {count} 条记忆？',
      'confirm.body': '这会清空存储文件，无法恢复。上游归档不受影响。',
      'empty.title': '还没有记忆',
      'empty.body': '在会话里让助手记住一些事，再回到这里查看。',
      'row.deleted': '删除中…',
      'archive.title': '上游归档 · 只读',
      'archive.meta': '版本 {version} · 画像 {chars} 字',
      'archive.note': '这里镜像的是上游应用的数据，本插件从不写入，因此不能在此清空。',
      'archive.absent': '没有镜像到上游归档（未设置 uid 或处于 standalone 模式）。',
      'error.load': '读取记忆库失败：',
      'error.render': '这个设置分区渲染失败：',
      'loading': '正在读取记忆…',
    }

    /**
     * 模板填充。
     * @param template - 带 `{name}` 占位的文案。
     * @param params - 替换值。
     * @returns 填充后的文案。
     */
    function fill(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
    }

    /**
     * 按 Host 的语言快照选字典。
     *
     * 不能用 `navigator.language`：桌面壳的 Chromium 语言跟随系统，不等于 Host
     * 实际渲染的语言，之前那次「面板全英文、其余全中文」就是这么来的。
     *
     * @param locale - Host 的 locale 服务。
     * @returns 当前语言对应的字典。
     */
    function dictionaryFor(locale) {
      const pick = () => {
        try {
          const active = String(locale?.getSnapshot?.()?.active ?? '')
          if (active.length > 0) return active
        } catch {
          /* 落到下面的中文兜底 */
        }
        return 'zh'
      }
      return /^zh/i.test(pick()) ? ZH : EN
    }

    /**
     * 解析路由绝对地址。
     *
     * DSH 可能挂在路径前缀下，根绝对 URL 会丢掉前缀、打到网关 404。
     *
     * @returns 绝对 URL。
     */
    function routeUrl() {
      const base = typeof document === 'undefined' ? undefined : document.baseURI
      if (typeof base !== 'string' || base.length === 0) return `/${ROUTE}`
      try {
        const url = new URL(base)
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(ROUTE, url.href).href
      } catch {
        return `/${ROUTE}`
      }
    }

    /**
     * 调 Host 路由；永不抛。
     * @param body - 动作与字段。
     * @returns 解码后的应答，或带类型的传输失败。
     */
    async function callHost(body) {
      let response
      try {
        response = await fetch(routeUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, code: 'network', message: String(error) }
      }
      let decoded
      try {
        decoded = await response.json()
      } catch {
        decoded = undefined
      }
      if (decoded === null || typeof decoded !== 'object') {
        return { ok: false, code: 'http', message: `HTTP ${response.status} · ${routeUrl()}` }
      }
      return decoded
    }

    /**
     * 时间戳 → 本地 `YYYY-MM-DD HH:mm`。
     * 无法解析的时间戳返回空串，绝不印 `NaN`。
     * @param iso - ISO 时间串。
     * @returns 展示用时间。
     */
    function formatStamp(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const at = new Date(iso)
      if (!Number.isFinite(at.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /** 末级目录名，用于压缩展示。 */
    function baseName(dir) {
      if (typeof dir !== 'string' || dir.length === 0) return ''
      const parts = dir.split(/[\\/]+/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : dir
    }

    /**
     * 语言版本号：语言切换时 bump，订阅者据此重绘。
     * @returns `{ getSnapshot, subscribe, bump }`
     */
    function createLocaleTick() {
      let version = 0
      const listeners = new Set()
      return {
        getSnapshot: () => version,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        bump() {
          version += 1
          for (const listener of listeners) listener()
        },
      }
    }

    /** 数据库（叠盘）图标，表示"已存储的东西"。 */
    function MemoryGlyph(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('ellipse', {
          cx: 8,
          cy: 4,
          rx: 5.25,
          ry: 2.1,
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', {
          d: 'M2.75 4v3.6c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1V4',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M2.75 7.6v3.6c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1V7.6',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * 建立界面。
     * @param t - 文案函数。
     * @param tick - 语言版本号。
     * @returns `{ MemorySection }`
     */
    function createUi(t, tick) {
      /**
       * 设置分区本体。
       * 只从 Host 拿数据；渲染期抛错会被外层兜住并显示。
       */
      function MemorySection() {
        const [snapshot, setSnapshot] = React.useState({ status: 'loading', records: [], store: undefined, archive: undefined })
        const [busy, setBusy] = React.useState(false)
        const [confirming, setConfirming] = React.useState(false)
        const [removing, setRemoving] = React.useState('')
        const [error, setError] = React.useState('')

        // 语言切换后重绘，否则会一直显示挂载时那套文案。
        React.useEffect(() => tick.subscribe(() => setSnapshot((prev) => ({ ...prev }))), [tick])

        const load = React.useCallback(async () => {
          setBusy(true)
          setError('')
          const answer = await callHost({ action: 'list' })
          setBusy(false)
          if (answer.ok !== true) {
            setError(typeof answer.message === 'string' ? answer.message : String(answer.code ?? 'unknown'))
            return
          }
          setSnapshot({
            status: 'ready',
            records: Array.isArray(answer.records) ? answer.records : [],
            store: answer.store,
            archive: answer.archive,
          })
        }, [])

        React.useEffect(() => {
          void load()
        }, [load])

        const clearAll = React.useCallback(async () => {
          setBusy(true)
          setError('')
          const answer = await callHost({ action: 'clear', confirm: true })
          setBusy(false)
          setConfirming(false)
          if (answer.ok !== true) {
            setError(typeof answer.message === 'string' ? answer.message : String(answer.code ?? 'unknown'))
            return
          }
          await load()
        }, [load])

        const removeOne = React.useCallback(
          async (id) => {
            setRemoving(id)
            setError('')
            const answer = await callHost({ action: 'delete', id })
            setRemoving('')
            if (answer.ok !== true) {
              setError(typeof answer.message === 'string' ? answer.message : String(answer.code ?? 'unknown'))
            }
            await load()
          },
          [load],
        )

        const records = snapshot.records
        const count = records.length
        const storeDir = snapshot.store?.dir

        const subtitle =
          snapshot.status === 'ready'
            ? count === 0
              ? t('subtitle.empty')
              : t('subtitle.count', { count, dir: baseName(storeDir) || '—' })
            : t('loading')

        return h(
          'div',
          { className: 'mem-page' },
          h('style', null, stylesheet()),

          h(
            'div',
            { className: 'mem-head' },
            h('h2', { className: 'mem-title' }, t('title')),
            h('p', { className: 'mem-subtitle' }, subtitle),
          ),

          h(
            'div',
            { className: 'mem-toolbar' },
            h(
              'button',
              { type: 'button', className: 'mem-btn', onClick: () => void load(), disabled: busy },
              busy ? t('action.refreshing') : t('action.refresh'),
            ),
            count > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem-btn mem-btn-danger',
                    onClick: () => setConfirming(true),
                    disabled: busy || confirming,
                  },
                  t('action.clear'),
                )
              : null,
            storeDir ? h('span', { className: 'mem-path', title: storeDir }, storeDir) : null,
          ),

          error ? h('div', { className: 'mem-note mem-note-error', role: 'alert' }, `${t('error.load')} ${error}`) : null,

          confirming
            ? h(
                'div',
                { className: 'mem-confirm', role: 'alertdialog' },
                h('div', { className: 'mem-confirm-text' },
                  h('strong', null, t('confirm.title', { count })),
                  h('span', null, t('confirm.body')),
                ),
                h(
                  'div',
                  { className: 'mem-confirm-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'mem-btn', onClick: () => setConfirming(false), disabled: busy },
                    t('action.cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'mem-btn mem-btn-danger mem-btn-solid',
                      onClick: () => void clearAll(),
                      disabled: busy,
                    },
                    t('action.confirm'),
                  ),
                ),
              )
            : null,

          h('div', { className: 'mem-scroll' }, renderBody()),

          snapshot.status === 'ready' ? renderArchive() : null,
        )

        /** 列表区：加载中 / 空态 / 条目。 */
        function renderBody() {
          if (snapshot.status !== 'ready') return h('div', { className: 'mem-note' }, t('loading'))
          if (count === 0) {
            return h(
              'div',
              { className: 'mem-empty' },
              h('div', { className: 'mem-empty-title' }, t('empty.title')),
              h('div', { className: 'mem-empty-body' }, t('empty.body')),
            )
          }
          return records.map((record) =>
            h(
              'article',
              { className: 'mem-card', key: record.id },
              h('p', { className: 'mem-text' }, record.text),
              h(
                'div',
                { className: 'mem-meta' },
                record.scope ? h('span', { className: 'mem-chip' }, record.scope) : null,
                h('span', { className: 'mem-time' }, formatStamp(record.ts)),
                h('code', { className: 'mem-id' }, record.id),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mem-btn mem-btn-ghost',
                    onClick: () => void removeOne(record.id),
                    disabled: busy || removing === record.id,
                  },
                  removing === record.id ? t('row.deleted') : t('action.delete'),
                ),
              ),
            ),
          )
        }

        /** 归档只读块：只说事实，不给操作。 */
        function renderArchive() {
          const archive = snapshot.archive
          if (archive === undefined) {
            return h('div', { className: 'mem-archive mem-archive-muted' }, t('archive.absent'))
          }
          return h(
            'div',
            { className: 'mem-archive' },
            h('div', { className: 'mem-archive-head' }, t('archive.title')),
            h('code', { className: 'mem-archive-file' }, archive.file ?? ''),
            h(
              'div',
              { className: 'mem-archive-meta' },
              t('archive.meta', { version: archive.version ?? '—', chars: archive.blockChars ?? 0 }),
            ),
            h('div', { className: 'mem-archive-note' }, t('archive.note')),
          )
        }
      }

      return { MemorySection }
    }

    /**
     * 样式表。
     *
     * 用 `--dsw-alias-*` 主题变量，深色/浅色自动跟随；每个 `var()` 都带兜底，
     * 变量缺失时也不会出现黑底黑字。根节点自身不滚，只有列表滚——设置列
     * 由外壳裁切，滚动必须由内容自己负责。
     *
     * @returns CSS 文本。
     */
    function stylesheet() {
      return [
        '.mem-page{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;min-width:0;height:100%;min-height:0;max-height:100vh;max-height:100dvh;overflow:hidden;color:var(--dsw-alias-label-primary,currentColor);font-family:inherit;font-size:13px;line-height:20px;padding:2px 2px 0}',
        '.mem-head{display:flex;flex-direction:column;gap:4px}',
        '.mem-title{margin:0;font-size:18px;line-height:26px;font-weight:600}',
        '.mem-subtitle{margin:0;color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:18px}',
        '.mem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.mem-path{margin-left:auto;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,currentColor);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
        '.mem-btn{box-sizing:border-box;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer}',
        '.mem-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
        '.mem-btn:disabled{opacity:.5;cursor:default}',
        '.mem-btn-danger{color:var(--dsw-alias-state-error-primary,#d64545);border-color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.mem-btn-solid{background:var(--dsw-alias-state-error-primary,#d64545);color:#fff;border-color:transparent}',
        '.mem-btn-ghost{height:24px;padding:0 8px;border-color:transparent;color:var(--dsw-alias-label-secondary,currentColor);margin-left:auto}',
        '.mem-confirm{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border:0.5px solid var(--dsw-alias-state-error-primary,#d64545);border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}',
        '.mem-confirm-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 240px;font-size:12px}',
        '.mem-confirm-text span{color:var(--dsw-alias-label-secondary,currentColor)}',
        '.mem-confirm-actions{display:flex;gap:8px}',
        '.mem-scroll{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}',
        '.mem-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}',
        '.mem-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.mem-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.mem-chip{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));color:inherit}',
        '.mem-time{font-variant-numeric:tabular-nums}',
        '.mem-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.75;overflow:hidden;text-overflow:ellipsis;max-width:40%;white-space:nowrap}',
        '.mem-note{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,currentColor)}',
        '.mem-note-error{color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.mem-empty{display:flex;flex-direction:column;gap:4px;padding:24px 12px;align-items:center;text-align:center;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.mem-empty-title{color:var(--dsw-alias-label-primary,currentColor);font-weight:600}',
        '.mem-empty-body{font-size:12px;max-width:420px}',
        '.mem-archive{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:0.5px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:10px;font-size:11px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.mem-archive-muted{font-style:normal}',
        '.mem-archive-head{color:var(--dsw-alias-label-primary,currentColor);font-weight:600;font-size:12px}',
        '.mem-archive-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mem-archive-note{opacity:.9}',
      ].join('\n')
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale
        const t = (key, params) => fill(dictionaryFor(locale)[key] ?? EN[key] ?? key, params)
        const tick = createLocaleTick()
        const { MemorySection } = createUi(t, tick)

        // Host 在语言切换时会通知所有命名空间。
        ctx.on('locale/change', () => tick.bump())

        // 分区与图标共享一个 id：外壳按 id 把图标挂到对应导航项上，
        // 没有配对图标的 id 不会渲染。
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID, order: 60 }, MemoryGlyph),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 60, label: () => t('title') },
            MemorySection,
          ),
        )
      },
    }
  },
})
