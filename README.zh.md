# dsh-memory

跨会话长期记忆插件，面向 DeepSeek Harness（dsh）。

记忆只在本机生成与保存：助手在会话中把值得长期保留的事实写进插件自己的 append-only 库，之后任何会话都能召回。**不读取、不镜像任何外部应用的记忆文件。** 对外提供 `memory_recall` / `memory_update` / `memory_profile` 三个工具，以及一个可被其他插件复用的 `memory` 服务。

## 数据形态

| 能力 | 载体（默认路径） | 权限 |
| --- | --- | --- |
| 读写记忆 | `~/.dsh-memory/records.jsonl` | 读写 |

`records.jsonl` 是事件日志：每行一条 `add` / `correct` / `delete`，读取时按 id 折叠成当前状态（覆盖即就地替换，删除即移除）。行数超过阈值时在锁内压缩重写，文件不会无限增长。

写入侧是双层结构：同进程写者先按目录进内存队列串行，再由 `.records.lock` 兜住同机其他进程。
只靠文件锁会有饿死问题——N 个同进程写者抢一把锁，每轮只有一个能进，重试次数小于 N 就必然报
`lock_contention`。锁内只做"追加 + stat"，`records.jsonl` 体积越过下限才全量读一遍判断是否需要压缩，
临界区不随文件增长而变长。

## 安装

插件走 profile 的依赖 + patch 两层，与 `dsh-skills` 等插件一致。

`dsh plugin` 会拒绝 `desktop` profile（`profile "desktop" is managed exclusively by the Electron application`），
所以桌面端直接用客户端自带的 node 24 + pnpm 11 在 profile 目录里装：

```bash
cd ~/.dsh/profiles/desktop
D="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies"
"$D/node/bin/node" "$D/pnpm/bin/pnpm.mjs" add github:yixin2021/dsh-memory
```

然后把 `"dsh-memory"` 追加到该 profile `package.json` 的 `dsh.profile.bundles` 数组末尾
（本包自带 `cordis.patch.yml`，bundle 引用会自动插入 `id: memory` 的插件条目），再重启客户端。

本地改代码时可临时改用 `add file:/path/to/dsh-memory`；`file:` 是**快照**（硬链接），
改完源码要重跑一次 `add` 才生效，而 `github:` 依赖拉的是仓库里的已提交内容，本地改动必须提交并推送。

`github:` 依赖在 lockfile 里锁定到具体 commit，改了仓库之后要 `pnpm update dsh-memory` 才会拉到新提交；
只跑 `install` 会继续用旧版本。

校验组合结果（`desktop` 名字被占用，用同名软链绕过）：

```bash
mkdir -p /tmp/dshh/profiles && ln -sfn ~/.dsh/profiles/desktop /tmp/dshh/profiles/check
DSH_HOME=/tmp/dshh dsh --profile check --dump-config | grep -A1 "dsh-memory"
# 期望末尾出现： # == dsh-memory / - id: memory / name: dsh-memory
```

回滚：删掉 `bundles` 里的 `dsh-memory`，执行
`"$D/node/bin/node" "$D/pnpm/bin/pnpm.mjs" remove dsh-memory`，重启。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/.dsh-memory` | 自有库目录 |
| `recallLimit` | `8` | 单次召回上限（硬上限 50） |

示例（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        recallLimit: 6
```

## 工具

### `memory_recall`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | 是 | 自洽的自然语言描述，说明缺什么上下文 |
| `limit` | 否 | 返回条数上限 |

返回 `{ trace_id, query, hits[], note? }`。`hits[].score` 是查询词覆盖率加词频增益，同分时新记录优先；`hits` 为空时 `note` 说明库里没有匹配项。

### `memory_update`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `action` | 是 | `add` / `correct` / `delete` |
| `text` | 否 | 自洽陈述；`delete` 时不需要 |
| `id` | 否 | `correct` / `delete` 的目标条目 |
| `scope` | 否 | 项目或领域名 |

写入前做两道处理：绝对路径替换为 `[path omitted]`；命中密钥形态直接拒绝（`errorCode: secret_detected`），不做静默丢弃。单条上限 4000 字符，超出截断并回报 `truncated: true`。

### `memory_profile`

只读自检：库目录、库文件、有效条目数、事件行数。用来回答"记忆现在是什么状态"而不必猜。

## 设置页：记忆管理

桌面/网页宿主里，**设置 → 记忆** 是一个可视化的管理面板（客户端半边，`client.js`）：

- 列出当前存下的全部记忆：正文、`scope`、写入时间、条目 id，按时间倒序。
- 单条 **删除**（追加一条 `delete` 事件，不破坏 append-only 语义）。
- **清空全部**：二次确认后把 `records.jsonl` 原子重写为空，并回收条数。

页面不碰文件系统，全部事实来自本包的 Host 路由 `POST /api/dsh-memory`：

| 动作 | 请求体 | 应答 |
| --- | --- | --- |
| 列出 | `{ "action": "list" }` | `{ ok, records[], store{dir,file,records,lines} }` |
| 删除 | `{ "action": "delete", "id": "mem_…" }` | `{ ok, status, remaining }` |
| 清空 | `{ "action": "clear", "confirm": true }` | `{ ok, cleared }`；缺 `confirm` 时 `code: confirm-required` |

路由只在宿主提供 `connection` 服务时安装（用 `ctx.inject(['connection'], …)` 可选注入）；无头宿主上插件照常可用，只是没有设置页。

## 插件元数据：名称、说明、图标

插件列表里的标题与说明不是从 `package.json` 的 `description` 直接拿的，宿主 `pluginPackages.metaOf()` 的流程是：

1. 用包解析器找 `dsh-memory/locale/en.json`——**必须出现在 `exports` 里**，否则整块元数据静默消失；
2. 以该文件所在目录为基准，扫描全部 `*.json`，文件名必须是语言 id（`en`、`zh`、`pt-BR`），每个文件的 `meta.title` / `meta.description` 都必须是非空字符串；
3. 缺字段时回退到 `package.json` 的 `name`（标题）和 `description`（说明）；
4. 图标来自 `exports["./icon"]`（或 manifest 的 `icon` 字段），支持 SVG/PNG/JPEG/WebP，上限 256 KiB。

所以本包的 `locale/en.json`、`locale/zh.json` 提供：

| | 标题 `meta.title` | 说明 `meta.description` |
| --- | --- | --- |
| `en` | Memory | Long-term memory for the agent: recalls earlier decisions, preferences and project notes… |
| `zh` | 记忆 | 为智能体提供长期记忆：跨会话召回此前的决策、偏好与项目约定… |

新增语言只需往 `locale/` 放一个 `<语言 id>.json`，不必改代码；但 `files` 白名单与 `exports` 的 `./locale/*.json` 是前提，漏了 `git` 安装就拿不到文件。`en.json` 既是入口也是基准目录，缺了它，其余语言的标题与说明都不会显示。

## 版本兼容声明

宿主从 0.2.2-rc.2 起会在启动时校验插件的 `engines.dsh` 与 `@deepseek-ai/dsh-*` peer 范围，不满足就把插件行标为 `disabled` 并提示不兼容。

因此本包声明 `engines.dsh: "^0.2.2-rc.1"`——**不要写成精确版本**，精确版本只匹配一个发布，运行时的 rc 递增就会让插件整体失效。范围在 `includePrerelease` 语义下覆盖 0.2.2 全系预发布与 0.2.x，止步于 0.3.0；宿主升到 0.3.0 时需要重新核对接口再放宽。

`test/meta.test.mjs` 里有两条护栏用例守着这条规则（精确版本禁则 + 范围必须覆盖已发布运行时）。

## 复用核心逻辑

需要在自己的插件里用同一套存储与检索时，直接引子路径，不必重复实现：

```js
import { withLock, appendRecord, loadRecords, removeRecord, clearRecords } from 'dsh-memory/store'
import { redactPaths, truncateUtf16, looksLikeSecret } from 'dsh-memory/redact'
import { rankRecords, tokenize } from 'dsh-memory/retrieval'
```

`withLock` 返回 `{ ok, value }` 或 `{ ok: false, errorCode }`，不抛异常；`appendRecord` 等入口在其外层自动加锁，并发写不会丢记录。

## 目录结构

```
dsh-memory/
├── index.js              # 插件：Config / apply / 三个工具 / memory 服务 / Host 路由
├── client.js             # 客户端半边：设置 → 记忆 管理面板
├── lib/store.js          # append-only JSONL、文件锁、压缩、删除、清空
├── lib/management.js     # 设置页动作分发（纯逻辑，无宿主依赖）
├── lib/redact.js         # 路径脱敏、UTF-16 安全截断、密钥识别
├── lib/retrieval.js      # 中文二元组 + 英文分词的关键词打分
├── scripts/verify.mjs    # 只读健康检查（可 --selftest 跑端到端闭环）
├── cordis.patch.yml      # bundle patch：插入 id=memory
├── locale/               # 插件元数据：en.json / zh.json 的标题与说明
├── icon.svg              # 插件列表图标（经 exports["./icon"] 暴露）
└── test/                 # node --test，覆盖并发写入、锁、脱敏、排序、管理动作、元数据
```

## 验证

```bash
npm run check   # 逐文件 node --check
npm test        # 37 个用例：并发追加、锁争用、脱敏、排序、删除/清空/分发、元数据与图标
npm run verify  # 只读健康检查；加 -- --selftest 跑写入→召回→清空闭环
```

## 验证记忆是否生效

分三层看，每一层都有独立的观测点——上层通过不代表下层通过。

### 第 1 层：插件挂上了吗

新开一个会话，问一句「你的记忆策略是什么」。系统提示里存在 `# Memory` 段落（Recall / Update / Boundaries 三段），且工具列表里能看到 `memory_recall` / `memory_update` / `memory_profile`。

看不到就说明插件没挂载，别往下查——先看 profile 的 `dsh.profile.bundles` 与安装副本是否完整，以及插件是否被宿主的兼容性预检禁用。

### 第 2 层：命令行走一遍

```bash
cd /Users/ligudian/code/dsh-plugins/dsh-memory
npm run verify                 # 只读：库现状与召回可用性
npm run verify -- --selftest   # 额外在临时目录跑「写入 → 召回 → 清空」闭环
```

自检全部打 `✓` 就说明引擎（写、读、折叠、清空）没问题；这一步不碰你自己的库。

### 第 3 层：写入与召回

写入：在一个会话里说「记住：我偏好简洁的中文回答」。然后任选一种确认：

- **设置 → 记忆**：出现一条卡片，含正文、时间、`mem_…` id；
- 命令行：`cat ~/.dsh-memory/records.jsonl`，应多一行 `{"id":"mem_…","action":"add","text":"…"}`；
- 会话内直接调 `memory_profile`，返回的 `store.records` 加一。

**写入被拒也是生效的一种**：如果内容像密钥，返回 `status: rejected` + `errorCode: secret_detected`；含绝对路径时 `redactedPaths` 大于 0，且落盘文本里路径已变成 `[path omitted]`。

召回：**必须新开会话**——同一会话里模型已经知道那件事，不会去调 `memory_recall`，看起来就像"没生效"。新会话里问一个只有记忆才知道的问题（例如「我之前说偏好用什么语言回答？」），观察工具调用：

| 现象 | 含义 |
| --- | --- |
| 调了 `memory_recall`，`hits` 非空且 `score > 0` | 正常 |
| 调了但 `hits: []` | 关键词没覆盖。检索是字面匹配（中文二元组 + 英文分词），换个更贴近记忆原文的说法再试 |
| 压根没调 | 提示词策略没生效，或问题本身能从当前上下文回答——两种都不算故障 |

召回是关键词检索不是向量检索，**换个说法查不到是已知边界**，不是 bug。要缩小范围可以用 `scope` 给条目分组。

## 边界

- 不读取外部应用的记忆文件，也不写它们；记忆只来自本机会话里助手的写入。
- 召回是关键词检索，不是向量检索；跨语言同义改写（中文问、英文存）召回质量有限，需要时用 `scope` 收敛范围。
- 库是本机单文件，不跨设备同步。

MIT License.
