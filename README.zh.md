# dsh-memory

跨会话长期记忆插件，面向 DeepSeek Harness（dsh）。

它做三件事：把上游应用（下文简称 upstream）的长期记忆归档**只读镜像**进来、把工作区记忆（项目说明 + 最近日誌）纳入上下文、把新记忆写进自己的 append-only 库。对外提供 `memory_recall` / `memory_update` / `memory_profile` 三个工具，以及一个可被其他插件复用的 `memory` 服务。

## 为什么这样切分读写

上游应用的归档写入依赖三者协同：进程内按 uid 串行的互斥、`.lock` 文件锁、以及"写入版本必须不小于磁盘版本"的守卫。外部进程即使复刻文件锁，也无法参与上游的进程内互斥；一旦写入版本被判为 `same_version`，上游会**静默跳过**，同时用当前文件覆盖 `.bak` 备份。

所以本插件对归档严格只读，写入落自有存储：

| 能力 | 载体（默认路径） | 权限 |
| --- | --- | --- |
| 读云画像 | `<archiveRoot>/memory/[platform/<scope>/]<uid>_memory.md` | 只读 |
| 读用户级偏好 | `<archiveRoot>/user-<uid>-<scope>/MEMORY.md` | 只读 |
| 读项目记忆 | `<workspace>/<workspaceFolder>/memory/MEMORY.md` + 最近日誌 | 只读 |
| 读写自有记忆 | `~/.dsh-memory/records.jsonl` | 读写 |

`archiveRoot` 与 `workspaceFolder` 的默认值是上游应用在磁盘上使用的目录名（见下表），可取配置或环境变量覆盖；包内只有一处保留该字面量。

写入侧沿用同样的双层结构：同进程写者先按目录进内存队列串行，再由 `.records.lock` 兜住同机其他进程。
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
| `readMode` | `mirror` | `mirror` 读取上游归档与工作区记忆；`standalone` 只用自有库 |
| `uid` | `''` | 上游账号 uid；留空则不镜像归档 |
| `enterpriseId` | `''` | 企业作用域，决定 `memory/platform/<scope>/` 子目录 |
| `archiveRoot` | `~/.workbuddy` | 上游数据根目录；也可用 `DSH_MEMORY_ARCHIVE_ROOT` 覆盖 |
| `workspaceFolder` | `.workbuddy` | 工作区里的上游数据目录名；也可用 `DSH_MEMORY_WORKSPACE_FOLDER` 覆盖 |
| `workspace` | 进程工作目录 | 工作区记忆的根目录 |
| `dataDir` | `~/.dsh-memory` | 自有库目录 |
| `recallLimit` | `8` | 单次召回上限（硬上限 50） |
| `injectProfile` | `true` | 召回时是否附带归档画像摘要 |
| `injectLimit` | `4000` | 画像摘要字符上限 |

示例（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        uid: '71f9eb56-eb5c-45e8-964b-dcaa419a0ebe'
        recallLimit: 6
```

## 工具

### `memory_recall`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | 是 | 自洽的自然语言描述，说明缺什么上下文 |
| `limit` | 否 | 返回条数上限 |

返回 `{ trace_id, query, hits[], archive?, workspace?, profileExcerpt?, note? }`。`hits[].score` 是查询词覆盖率加词频增益，同分时新记录优先。

### `memory_update`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `action` | 是 | `add` / `correct` / `delete` |
| `text` | 否 | 自洽陈述；`delete` 时不需要 |
| `id` | 否 | `correct` / `delete` 的目标条目 |
| `scope` | 否 | 项目或领域名 |

写入前做两道处理：绝对路径替换为 `[path omitted]`；命中密钥形态直接拒绝（`errorCode: secret_detected`），不做静默丢弃。单条上限 4000 字符，超出截断并回报 `truncated: true`。

### `memory_profile`

只读自检：归档路径、版本、`updatedAt`、`memoryBlock` 字符数、自有库记录数与行数。用来回答"记忆现在是什么状态"而不必猜。

## 设置页：记忆管理

桌面/网页宿主里，**设置 → 记忆** 是一个可视化的管理面板（客户端半边，`client.js`）：

- 列出当前存下的全部记忆：正文、`scope`、写入时间、条目 id，按时间倒序。
- 单条 **删除**（追加一条 `delete` 事件，不破坏 append-only 语义）。
- **清空全部**：二次确认后把 `records.jsonl` 原子重写为空，并回收条数。
- 底部展示上游归档的只读元信息（文件、版本、画像字数），并明确标注只读——它不提供任何清除入口。

页面不碰文件系统，全部事实来自本包的 Host 路由 `POST /api/dsh-memory`：

| 动作 | 请求体 | 应答 |
| --- | --- | --- |
| 列出 | `{ "action": "list" }` | `{ ok, records[], store{dir,file,records,lines}, archive? }` |
| 删除 | `{ "action": "delete", "id": "mem_…" }` | `{ ok, status, remaining }` |
| 清空 | `{ "action": "clear", "confirm": true }` | `{ ok, cleared }`；缺 `confirm` 时 `code: confirm-required` |

路由只在宿主提供 `connection` 服务时安装（用 `ctx.inject(['connection'], …)` 可选注入）；无头宿主上插件照常可用，只是没有设置页。

## 复用核心逻辑

需要在自己的插件里读同一份归档时，直接引子路径，不必重复实现：

```js
import { readArchive, parseProfile, serializeProfile } from 'dsh-memory/archive'
import { withLock, appendRecord, loadRecords } from 'dsh-memory/store'
import { redactPaths, truncateUtf16, looksLikeSecret } from 'dsh-memory/redact'
import { rankRecords, tokenize } from 'dsh-memory/retrieval'
```

`parseProfile` / `serializeProfile` 与主机侧格式逐字节兼容：Markdown 外壳 + HTML 注释里的权威 JSON，全字段 `JSON.stringify(profile, null, 2)`，往返不丢 `memoryIndex`。解析在 JSON 损坏时回退到头部与正文正则，与主机侧同策略。

## 目录结构

```
dsh-memory/
├── index.js              # 插件：Config / apply / 三个工具 / memory 服务 / Host 路由
├── client.js             # 客户端半边：设置 → 记忆 管理面板
├── lib/archive.js        # 归档读写与格式兼容、工作区记忆
├── lib/store.js          # append-only JSONL、文件锁、压缩、删除、清空
├── lib/management.js     # 设置页动作分发（纯逻辑，无宿主依赖）
├── lib/redact.js         # 路径脱敏、UTF-16 安全截断、密钥识别
├── lib/retrieval.js      # 中文二元组 + 英文分词的关键词打分
├── scripts/verify.mjs    # 只读健康检查（可 --selftest 跑端到端闭环）
├── cordis.patch.yml      # bundle patch：插入 id=memory
└── test/                 # node --test，覆盖格式往返、并发写入、锁、脱敏、排序、管理动作
```

## 验证

```bash
npm run check   # 逐文件 node --check
npm test        # 37 个用例：格式往返、降级解析、并发追加、锁争用、脱敏、排序、删除/清空/分发
npm run verify  # 只读健康检查；加 -- --selftest 跑写入→召回→清空闭环
```

## 验证记忆是否生效

分四层看，每一层都有独立的观测点——上层通过不代表下层通过。

### 第 1 层：插件挂上了吗

新开一个会话，问一句「你的记忆策略是什么」。系统提示里存在 `# Memory` 段落（Recall / Update / Boundaries 三段），且工具列表里能看到 `memory_recall` / `memory_update` / `memory_profile`。

看不到就说明插件没挂载，别往下查——先看 profile 的 `dsh.profile.bundles` 与安装副本是否完整。

### 第 2 层：命令行走一遍

```bash
cd /Users/ligudian/code/dsh-plugins/dsh-memory
npm run verify                 # 只读：库现状 + 归档镜像
npm run verify -- --selftest   # 额外在临时目录跑「写入 → 召回 → 清空」闭环
DSH_MEMORY_UID=<uid> npm run verify   # 顺带检查归档能否读到
```

自检全部打 `✓` 就说明引擎（写、读、折叠、清空）没问题；这一步不碰你自己的库。

### 第 3 层：写入是否落盘

在一个会话里说「记住：我偏好简洁的中文回答」。然后任选一种确认：

- **设置 → 记忆**：出现一条卡片，含正文、时间、`mem_…` id；
- 命令行：`cat ~/.dsh-memory/records.jsonl`，应多一行 `{"id":"mem_…","action":"add","text":"…"}`；
- 会话内直接调 `memory_profile`，返回的 `store.records` 加一。

**写入被拒也是生效的一种**：如果内容像密钥，返回 `status: rejected` + `errorCode: secret_detected`；含绝对路径时 `redactedPaths` 大于 0，且落盘文本里路径已变成 `[path omitted]`。

### 第 4 层：召回是否命中

**必须新开会话**——同一会话里模型已经知道那件事，不会去调 `memory_recall`，看起来就像"没生效"。

新会话里问一个只有记忆才知道的问题（例如「我之前说偏好用什么语言回答？」），观察工具调用：

| 现象 | 含义 |
| --- | --- |
| 调了 `memory_recall`，`hits` 非空且 `score > 0` | 正常 |
| 调了但 `hits: []` | 关键词没覆盖。检索是字面匹配（中文二元组 + 英文分词），换个更贴近记忆原文的说法再试 |
| 压根没调 | 提示词策略没生效，或问题本身能从当前上下文回答——两种都不算故障 |

召回是关键词检索不是向量检索，**换个说法查不到是已知边界**，不是 bug。要缩小范围可以用 `scope` 给条目分组。

### 归档镜像那一层（可选）

`uid` 未设置时插件只用自己的库，这是默认状态，不是故障。设了 `uid` 后归档只贡献两样东西：`blockChars` 元信息、以及 `profileExcerpt`（画像摘要）。**归档里的内容不会进入 `hits`**——`memory_recall` 只检索自有库。所以「归档读到了但召回里没有」属于预期行为。

## 边界

- 不写上游归档，也不尝试接管其锁。
- 不调用上游应用的远端记忆接口（`/api/memory/*`）：那条链路需要登录态与 `Authorization`、`X-User-ID`、`X-Enterprise-Id`，且端点无公开版本契约，属未授权接入。
- 召回是关键词检索，不是向量检索；跨语言同义改写（中文问、英文存）召回质量有限，需要时用 `scope` 收敛范围。

MIT License.
