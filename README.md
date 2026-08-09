# IluDB

IluDB is a small in-memory database for Node.js and the browser. Store plain JavaScript objects, query them with strict equality, sort results, add exact or whole-word text indexes, and extend the database through plugins.

It is a practical fit for local application state, prototypes, tests, browser data sets, and small embedded Node.js workloads that benefit from a compact, predictable API.

## Why IluDB

- **Start with plain objects.** Collections expose a focused CRUD API without a query language or schema layer.
- **Keep returned data isolated.** IluDB returns deep copies from `add`, `get`, `find`, `findOne`, `update`, and `searchText`, so changing a result does not change the stored document.
- **Add indexes where they matter.** Exact indexes accelerate covered equality queries. Text indexes provide normalized whole-word `AND` and `OR` search.
- **Use the same core in Node.js and the browser.** The package includes readable and minified UMD bundles plus public TypeScript declarations.
- **Add JSON persistence in Node.js.** The optional `node-json` plugin provides synchronous saves, transactional reloads, revision conflicts, same-directory file replacement, and file watching.

## Install IluDB in your application

```bash
npm install iludb
```

Use the package with an ES module import:

```ts
import IluDB from "iludb";
```

The default import works in Node.js ESM and bundlers through CommonJS interoperability. IluDB does not publish a native ESM bundle.

Or with CommonJS:

```js
const IluDB = require("iludb");
```

## Quickstart

Create a database, get a collection, and store your first documents:

```ts
import IluDB from "iludb";

type Task = {
  title: string;
  status: "open" | "done";
  priority: number;
};

const database = IluDB<Task>();
const tasks = database.getCollection("tasks");

const first = tasks.add({
  title: "Ship the prototype",
  status: "open",
  priority: 2
});

tasks.add({
  title: "Write the release notes",
  status: "done",
  priority: 1
});

const openTasks = tasks.find({ status: "open" }, { sort: { priority: 1 } });

if (first) {
  tasks.update({ ...first, status: "done" });
}
```

`add()` assigns `$id`, `$createdAt`, and `$modifiedAt`. Those metadata fields are reserved. Documents can contain primitives, arrays, nested plain objects, and `Date` values.

Queries are plain objects. Every supplied field must match by strict equality. An empty query matches every document.

## Essential collection API

| Method                      | Behavior                                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add(document)`             | Stores a document, assigns metadata, and returns an isolated copy. Non-object values, `null`, and arrays return `undefined`. Reserved metadata fields throw.                                                                                                                        |
| `get(id)`                   | Returns the document whose `$id` strictly equals `id`, or `undefined`.                                                                                                                                                                                                              |
| `find(query?, options?)`    | Returns all matches. `options.sort` accepts direct field names with `1` for ascending order and `-1` for descending order.                                                                                                                                                          |
| `findOne(query?, options?)` | Uses the same query and sort contract, then returns the first match or `undefined`.                                                                                                                                                                                                 |
| `sort(array, options?)`     | Returns the original array when no sort fields are supplied. Otherwise it returns a stable sorted copy.                                                                                                                                                                             |
| `update(document)`          | Finds the document with the supplied `$id`, merges the document's own non-metadata fields, preserves omitted fields and reserved metadata, refreshes `$modifiedAt`, and returns an isolated copy. It throws `Error("The document does not exist.")` when that `$id` does not exist. |
| `remove(document)`          | Removes the document with the supplied `$id`. It throws `Error("The document does not exist.")` when that `$id` does not exist.                                                                                                                                                     |
| `count(query?)`             | Counts documents with the same strict-equality query contract.                                                                                                                                                                                                                      |

Queries are optional. When supplied to `find`, `findOne`, or `count`, they must be plain objects. Sort directions are limited to `1` and `-1`.

## Accelerate equality queries with exact indexes

Create a simple index for one field or a compound index for a combination of fields:

```ts
const users = database.getCollection<{
  email: string;
  tenantId: number;
  status: "active" | "disabled";
}>("users");

users.createIndex("by-email", "email");
users.createIndex("by-tenant-status", ["tenantId", "status"]);

const activeUsers = users.find({ tenantId: 7, status: "active" });

users.getIndexes();
users.dropIndex("by-email");
```

`find`, `findOne`, and `count` select a covered exact index automatically. IluDB prefers the index with the most covered fields. When equally wide indexes qualify, it chooses the posting with the fewest candidates. Every candidate still passes the complete query, so indexed and linear queries preserve the same matching contract.

Selectivity determines the practical value of an index. A field or field combination that narrows a query to fewer documents gives IluDB fewer candidates to validate. A compound index is covered only when the query includes every field declared by that index.

Indexes consume runtime memory and add maintenance work to `add`, `update`, and `remove`. Create them for recurring, selective queries rather than every available field. Documents missing any indexed field receive no posting for that index.

Index names and field names must be non-empty trimmed strings. Every field list must contain unique names, and exact and text indexes share the same index name space. `dropIndex()` returns `false` when the index does not exist.

## Search normalized whole words

Text indexes combine one or more direct string fields into a whole-word search surface:

```ts
type Article = {
  title: string;
  body: string;
};

const articles = database.getCollection<Article>("articles");

articles.add({
  title: "Small database",
  body: "Exact indexes keep equality queries focused"
});

articles.createTextIndex("content", ["title", "body"]);

const everyToken = articles.searchText("content", "database indexes");
const eitherToken = articles.searchText("content", "database browser", {
  operator: "OR"
});

articles.getTextIndexes();
articles.dropTextIndex("content");
```

The default `AND` operator requires every token. `OR` returns each document that contains at least one token without duplicates.

Tokenization applies Unicode NFKD normalization, removes combining marks, converts text to lowercase, and splits on non-alphanumeric characters. Search matches complete normalized tokens. It does not provide fuzzy matching, prefixes, stemming, ranking, or relevance scores. Missing fields and non-string values contribute no tokens.

## Keep indexes synchronized

Exact and text indexes live only in runtime memory. IluDB builds them when declared and updates them through `add`, `update`, and `remove`. Index definitions and postings are excluded from JSON persistence.

Direct changes to `database.data` bypass metadata updates, automatic persistence, and index synchronization. Rebuild every declared index on the affected collection after a direct mutation:

```ts
const tasks = database.getCollection("tasks");
const storedTask = database.data.collections.tasks.data[0];

storedTask.status = "done";

tasks.reindex();
```

`reindex()` preserves the current array order and index definitions, updates wrappers that share the collection data, and returns the collection for chaining. It builds replacement index state before publishing it. If rebuilding throws, the prior index state remains active. IluDB does not detect direct mutations or call `reindex()` automatically.

If the database uses `node-json`, call `database.save()` after `reindex()` to persist the direct mutation.

## Persist a database as JSON in Node.js

The `node-json` plugin is Node-only because it depends on the Node.js `fs` module. Register it once, then pass a file path to `IluDB()`:

```ts
import IluDB from "iludb";
import nodeJSONPlugin from "iludb/plugins/node-json";

IluDB.use(nodeJSONPlugin);

const database = IluDB("./data/database.json");
const sessions = database.getCollection("sessions");

sessions.add({ userId: 42, state: "active" });
```

The plugin loads an existing file or creates a new one. `add`, `update`, and `remove` call `save()` automatically. JSON changes reach the file before those methods return.

### Synchronous saves and atomic replacement

`save()` is synchronous. Serialization and filesystem errors propagate to the caller before it returns.

The plugin writes a unique temporary file in the destination directory, calls `fsync` on its file descriptor, and publishes it with `rename`. On filesystems that support atomic same-directory replacement, readers do not observe a partially written JSON document. Existing POSIX mode bits are preserved.

This contract covers visible atomic replacement. The plugin does not call `fsync` on the parent directory, so it does not guarantee that the rename survives sudden power loss. Ownership, ACLs, and extended attributes are outside the persistence contract.

### Revisions and conflicts

Every persisted snapshot has a non-negative `revision`. Before writing, `save()` compares the revision on disk with the revision loaded by the current database instance.

```ts
try {
  database.save();
} catch (error) {
  if (error instanceof nodeJSONPlugin.ConflictError) {
    console.error(error.expectedRevision, error.actualRevision);
  } else {
    throw error;
  }
}
```

A mismatch throws `nodeJSONPlugin.ConflictError`. Its `expectedRevision` property contains the loaded revision and `actualRevision` contains the disk revision. `actualRevision` is `null` when the loaded destination disappeared. A failed save preserves local changes and does not advance the local revision.

Revision checks detect stale snapshots, but a time-of-check/time-of-use gap remains because the plugin has no lock or multiwriter protocol. Use one writer and any number of readers. IluDB does not merge, retry, or resolve conflicts.

Legacy files without `revision` load as revision `0`. Their next successful save publishes revision `1`.

### Transactional reload

```ts
database.reload();
```

`reload()` synchronously reads, validates, and stages the complete file before replacing the active snapshot. A successful reload discards unsaved local changes. A failed reload preserves the current data reference, collection wrappers, index state, and loaded revision.

Existing wrappers remain usable when their named collection survives the reload. A removed collection makes its wrappers inactive until `getCollection(name)` recreates it or a later reload restores it. Operations on an inactive wrapper throw `Error("The collection is inactive after reload.")`. References to prior data objects, collections, arrays, or documents can become stale after a successful reload.

### Watch external replacements

```ts
database.watch({
  interval: 500,
  onReload(reloaded) {
    console.log(`Loaded revision ${reloaded.data.revision}`);
  },
  onError(error) {
    console.error(error.message);
  }
});

database.unwatch();
```

`watch()` uses `fs.watchFile` with a default interval of `500` milliseconds and `persistent: false`. It reloads valid external replacements automatically. Both callbacks are optional.

Invalid or deleted files leave the active snapshot intact while the watcher waits for another file signature. Saves from the same database instance update the watch baseline and do not call `onReload`. A second active `watch()` call has no effect. `unwatch()` is idempotent.

Changing `database.dir` does not retarget an active watcher. Call `unwatch()`, update the path, and call `watch()` again.

### Date behavior in JSON

On load, the plugin restores IluDB metadata timestamps as `Date` instances:

- `createdAt` and `modifiedAt` on the database and collections
- `$createdAt` and `$modifiedAt` on documents

These timestamps must contain the canonical ISO string produced by `Date#toJSON` or `Date#toISOString`. Missing or invalid metadata throws a `TypeError` that identifies the affected path.

User fields follow standard JSON semantics. An ISO string stays a string. A user-supplied `Date` serializes to an ISO string and reloads as a string.

## Environments, formats, and types

The package exports two public entrypoints:

- `iludb` for the in-memory core
- `iludb/plugins/node-json` for Node.js JSON persistence

The core ships as readable and minified UMD bundles. They support CommonJS and AMD and expose `IluDB` as a global when loaded in a compatible global runtime. The default import shown above relies on CommonJS interoperability in Node.js ESM or a bundler. IluDB does not ship a native ESM bundle. Package metadata points browser consumers to the minified core bundle.

The JSON plugin uses the same UMD distribution shape and exposes `IluDBNodeJSONPlugin` as its global. Its uniform wrapper does not make it browser-compatible. The plugin externalizes `fs` and requires a Node-compatible runtime.

TypeScript declarations ship for both public entrypoints. They include document metadata, typed queries and sorting, exact and text indexes, JSON revisions, watch options, and `ConflictError`.

The published package contains `package.json`, the distribution files, `README.md`, and `LICENSE`.

## Repository development

The repository uses Bun for contributor workflows. Applications install and consume IluDB through the npm package as shown above.

Install the locked toolchain dependencies:

```sh
bun install --frozen-lockfile
```

Run the project checks and builds:

```sh
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test
```

`bun run test` builds the package before running the core and public-entrypoint test suites.

### Benchmarks

Run the fixed-workload benchmark:

```sh
bun run bench
```

The benchmark builds the package, warms up each workload, and reports the median and range from five measured samples by default. It covers CRUD operations, scans, exact indexes at several selectivities, text search, index maintenance, `reindex()`, and same-directory JSON replacement and reload with 100 and 1,000 documents.

Configure the run with environment variables:

```sh
BENCH_SAMPLES=7 BENCH_TARGET_MS=2000 bun run bench
BENCH_BASELINE=./path/to/baseline.js bun run bench
```

`BENCH_SAMPLES` must be an integer of at least `3`. `BENCH_TARGET_MS` sets the approximate total measured duration per operation. `BENCH_BASELINE` runs the same workload against another bundle and prints a throughput ratio for each supported operation.

The benchmark is observational. The project does not enforce performance thresholds in CI, and the README does not claim performance results without a recorded environment and run.

## Limits to consider

- Data lives in process memory unless the Node-only JSON plugin persists it.
- Queries use direct fields and strict equality. IluDB does not provide MongoDB-style operators or nested field paths.
- Text search covers normalized whole words with `AND` and `OR`. It has no fuzzy search, ranking, stemming, or prefix search.
- Runtime indexes consume memory and increase the work required for indexed writes.
- Direct mutation of `database.data` bypasses automatic index maintenance and JSON saves.
- JSON persistence is synchronous and can block the Node.js event loop while it serializes or accesses the filesystem.
- On filesystems that support atomic same-directory replacement, readers do not see a partial JSON file. The plugin does not promise physical durability across sudden power loss.
- Revision conflicts detect stale snapshots without providing locks, merge, retries, or safe multiwriter coordination. Use one writer and any number of readers.

## License

Apache-2.0
