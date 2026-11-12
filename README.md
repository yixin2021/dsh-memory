# dsh-memory

Persistent cross-session memory for DeepSeek Harness.

Memory is created and kept on this machine only: the assistant writes durable facts into the plugin's own append-only store, and any later session can recall them. **No external app's memory files are read or mirrored.** Three tools — `memory_recall`, `memory_update`, `memory_profile` — plus a `memory` service other plugins can reuse.

## Data shape

Everything lives in `~/.dsh-memory/records.jsonl`, a single event log: each line is an `add` / `correct` / `delete`, and reads fold those events into current state (a correction replaces in place, a deletion removes). Past a size floor the file is compacted inside the lock, so it does not grow without bound.

Writes use a two-layer shape: same-process writers queue in memory per directory, and `.records.lock` only guards other processes on the machine. A file lock alone starves writers — N same-process writers contend for one lock, one wins per round, so any retry count below N ends in `lock_contention`. The critical section stays `append + stat`; the file is only re-read for compaction once it passes the size floor.

## Install

```bash
cd ~/.dsh/profiles/<profile>
pnpm add github:yixin2021/dsh-memory
# then add "dsh-memory" to dsh.profile.bundles in that profile's package.json
```

Local development can use `pnpm add file:/path/to/dsh-memory` instead; a `file:` install is a snapshot, so re-run it after editing sources.

A `github:` dependency is pinned to a commit in the lockfile: after pushing changes, run `pnpm update dsh-memory` — a plain `install` keeps the old commit.

The bundle's `cordis.patch.yml` inserts the plugin as `id: memory`.

## Config

`dataDir` (default `~/.dsh-memory`) and `recallLimit` (default 8, hard cap 50). See `README.zh.md` for a patch example.

## Settings page

In the desktop and web hosts, **Settings → Memory** is a management panel (the `client.js` half):

- lists every stored entry (text, `scope`, timestamp, id) newest first;
- **Delete** one entry — appends a `delete` event, keeping the store append-only;
- **Clear all** — after a confirmation step, atomically rewrites `records.jsonl` empty and reports how many went.

The panel never touches the filesystem: everything comes from this package's own Host route `POST /api/dsh-memory`
(`{"action":"list"}` · `{"action":"delete","id":"mem_…"}` · `{"action":"clear","confirm":true}`).
The route is mounted only when the host provides `connection` (optional injection), so headless hosts keep working without it.

## Plugin metadata: title, description, icon

The plugin list does not read `description` from `package.json` directly. The host's `pluginPackages.metaOf()` does this:

1. resolves `dsh-memory/locale/en.json` through the package's **`exports` map** — without that export the whole metadata block silently disappears;
2. scans every `*.json` next to it, each named after a language id (`en`, `zh`, `pt-BR`), and requires `meta.title` / `meta.description` to be non-empty strings;
3. falls back to `package.json` `name` (title) and `description` (description) when a locale omits a field;
4. takes the icon from `exports["./icon"]` (or a manifest `icon` path): SVG, PNG, JPEG or WebP up to 256 KiB.

So this package ships `locale/en.json` and `locale/zh.json`, each with `meta.title` and `meta.description`. Adding a language is one file in `locale/`; no code change. Both `files` (`locale/*.json`) and `exports` (`./locale/*.json`) are load-bearing — a `file:` install would still work from the local tree, but a `git`/registry install only sees whitelisted files. `en.json` is both the entry point and the directory anchor, so every other language depends on it.

## Version compatibility

Since host 0.2.2-rc.2, the runtime validates a plugin's `engines.dsh` and `@deepseek-ai/dsh-*` peer ranges at startup; a mismatch disables the plugin row and reports it as incompatible.

This package therefore declares `engines.dsh: "^0.2.2-rc.1"` — **never pin an exact version**, because an exact pin matches a single release and the next rc disables the whole plugin. Under `includePrerelease` semantics the range covers every 0.2.2 prerelease and 0.2.x, stopping at 0.3.0; raising the floor to 0.3.0 requires re-checking the host APIs first.

Two guard tests in `test/meta.test.mjs` enforce this (no exact pins; the range must satisfy every released runtime).

## Reuse

```js
import { withLock, appendRecord, loadRecords, removeRecord, clearRecords } from 'dsh-memory/store'
import { redactPaths, truncateUtf16, looksLikeSecret } from 'dsh-memory/redact'
import { rankRecords, tokenize } from 'dsh-memory/retrieval'
```

`withLock` returns `{ ok, value }` or `{ ok: false, errorCode }` instead of throwing; the exported store entry points take the lock themselves, so concurrent writes do not lose records.

## Verify

```bash
npm run check
npm test        # 37 cases: concurrent appends, lock contention, redaction, ranking, delete/clear/dispatch, locale metadata and icon
npm run verify  # read-only health check; add -- --selftest for a write → recall → clear round trip
```

Three layers, each with its own signal: (1) the tools and the `# Memory` prompt section exist in a new session; (2) `npm run verify` is green; (3) a "remember this" request adds a record to `~/.dsh-memory/records.jsonl` and to **Settings → Memory**, and a **new session** asking something only memory knows triggers `memory_recall` with a non-empty `hits`. The recall step needs a fresh session — in the same conversation the model already knows the fact and will not call recall.

## Boundaries

- Reads and writes nothing outside this machine's own store.
- Recall is keyword-based, not vector-based; cross-language paraphrase recall is limited. Use `scope` to narrow.
- The store is a single local file; it does not sync across devices.

MIT License.
