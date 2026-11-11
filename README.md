# dsh-memory

Persistent cross-session memory for DeepSeek Harness.

It mirrors an upstream app's memory archive **read-only**, folds in workspace memory (project instructions plus the latest daily log), and keeps its own append-only store for new entries. Three tools — `memory_recall`, `memory_update`, `memory_profile` — plus a `memory` service other plugins can reuse.

## Why reads and writes go to different places

An upstream archive write relies on three cooperating guards: a per-uid in-process mutex, a `.lock` file, and a version guard that refuses writes older than the file on disk. An external process can imitate the file lock but cannot join the upstream mutex. Worse, a write whose version equals the on-disk version is treated as `same_version` and **silently skipped**, while the current file is copied over `.bak` first — so an outside writer can both lose its data and destroy the backup.

So this plugin never writes an archive. Writes go to `~/.dsh-memory/records.jsonl`, an event-sourced log that folds `add` / `correct` / `delete` into current state and compacts above 2000 lines.

## Install

```bash
cd ~/.dsh/profiles/<profile>
pnpm add /Users/ligudian/code/dsh-plugins/dsh-memory
# then add "dsh-memory" to dsh.profile.bundles in that profile's package.json
```

The bundle's `cordis.patch.yml` inserts the plugin as `id: memory`.

## Config

`readMode` (`mirror` | `standalone`), `uid`, `enterpriseId`, `archiveRoot`, `workspaceFolder`, `workspace`, `dataDir`, `recallLimit`, `injectProfile`, `injectLimit`. See `README.zh.md` for the table and a patch example. `archiveRoot` and `workspaceFolder` default to the upstream app's on-disk folder names and can be overridden by config or by `DSH_MEMORY_ARCHIVE_ROOT` / `DSH_MEMORY_WORKSPACE_FOLDER`.

## Settings page

In the desktop and web hosts, **Settings → Memory** is a management panel (the `client.js` half):

- lists every stored entry (text, `scope`, timestamp, id) newest first;
- **Delete** one entry — appends a `delete` event, keeping the store append-only;
- **Clear all** — after a confirmation step, atomically rewrites `records.jsonl` empty and reports how many went;
- shows the mirrored upstream archive as read-only metadata (file, version, profile characters) with no clear action, because that data belongs to another application.

The panel never touches the filesystem: everything comes from this package's own Host route `POST /api/dsh-memory`
(`{"action":"list"}` · `{"action":"delete","id":"mem_…"}` · `{"action":"clear","confirm":true}`).
The route is mounted only when the host provides `connection` (optional injection), so headless hosts keep working without it.

## Reuse

```js
import { readArchive, parseProfile, serializeProfile } from 'dsh-memory/archive'
import { withLock, appendRecord, loadRecords } from 'dsh-memory/store'
import { redactPaths, truncateUtf16, looksLikeSecret } from 'dsh-memory/redact'
import { rankRecords, tokenize } from 'dsh-memory/retrieval'
```

`parseProfile` / `serializeProfile` are byte-compatible with the host format: a Markdown shell plus the authoritative JSON inside an HTML comment, serialized with `JSON.stringify(profile, null, 2)` so `memoryIndex` and other extra fields survive a round trip.

## Verify

```bash
npm run check
npm test        # 35 cases: format round trip, degraded parse, concurrent appends, lock contention, redaction, ranking
npm run verify  # read-only health check; add -- --selftest for a write → recall → clear round trip
```

Four layers, each with its own signal: (1) the tools and the `# Memory` prompt section exist in a new session; (2) `npm run verify` is green; (3) a "remember this" request adds a record to `~/.dsh-memory/records.jsonl` and to **Settings → Memory**; (4) a **new session** asking something only memory knows triggers `memory_recall` with a non-empty `hits`. Layer 4 needs a fresh session — in the same conversation the model already knows the fact and will not call recall.

## Boundaries

- Never writes an upstream archive and never takes over its lock.
- Does not call the upstream app's `/api/memory/*` endpoints: they need a live session plus `Authorization` / `X-User-ID` / `X-Enterprise-Id`, and have no public versioned contract.
- Recall is keyword-based, not vector-based; cross-language paraphrase recall is limited. Use `scope` to narrow.

MIT License.
