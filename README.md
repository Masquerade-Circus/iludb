# IluDB

Store and query plain JavaScript objects in your application. IluDB is a small in-memory database with collections, strict-equality queries, sorting, and normalized whole-word text search. Keep data in memory, persist JSON files in Node.js or Bun, or use synchronous localStorage persistence in the browser.

Use it for local application state, prototypes, tests, browser data sets, and small embedded workloads that benefit from a focused collection API.

## Why IluDB

- **Start with plain objects.** Collections expose a focused CRUD API without a query language or schema layer.
- **Keep returned data isolated.** IluDB returns deep copies from `add`, `get`, `find`, `findOne`, `update`, and `searchText`, so changing a result does not change the stored document.
- **Add indexes where they matter.** Exact indexes accelerate covered equality queries. Text indexes provide normalized whole-word `AND` and `OR` search.
- **Start in memory and choose persistence when you need it.** Use the core without an adapter, JSON files in Node.js or Bun, or synchronous localStorage in the browser.
- **Commit related changes together.** Persistence adapters provide transactions that publish several mutations in one snapshot. Rejected transactions leave the active snapshot unchanged. All three adapters also provide revision checks, isolated snapshots, and watching.
- **Use TypeScript or JavaScript.** The package includes public TypeScript declarations and readable and minified UMD bundles.

[Store your first documents](#quickstart), [choose storage for your environment](#choose-where-your-data-lives), or [check the limits](#limits-to-consider) before integrating.

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
console.log(openTasks.map((task) => task.title));
// ["Ship the prototype"]

if (first) {
  tasks.update({ ...first, status: "done" });
}
```

You have stored two tasks, queried the open ones, and marked the first task as done. This database lives in memory and needs no adapter. To keep data between runs, choose a persistence adapter below.

`add()` assigns `$id`, `$createdAt`, and `$modifiedAt`. Those metadata fields are reserved. Documents can contain primitives, arrays, nested plain objects, and `Date` values.

Queries are plain objects. Every supplied field must match by strict equality. An empty query matches every document.

## Choose where your data lives

| Your application needs                        | Use                                               | Execution mode              |
| --------------------------------------------- | ------------------------------------------------- | --------------------------- |
| Data in memory without storage setup          | `iludb`, without an adapter                        | Synchronous                 |
| JSON files in Node.js                         | [`node-json`](#persist-a-database-as-json-in-nodejs) | Synchronous or asynchronous |
| JSON files in Bun                             | [`bun-json`](#persist-a-database-as-json-in-bun)     | Synchronous or asynchronous |
| Browser persistence under an origin-scoped key | [`local-storage`](#persist-in-browser-localstorage) | Synchronous only            |

Choose one writer per file or localStorage key. Revision checks detect stale snapshots but do not provide safe multiwriter coordination. localStorage access and data cloning block the main thread. Node/Bun async methods await filesystem I/O, while cloning, serialization, validation, and index rebuilding still run synchronously in memory.

### Choose sync or async in Node.js and Bun

Both filesystem adapters support both modes. The Node example below uses synchronous methods, and the Bun example uses asynchronous methods. Either adapter can use either mode.

`getCollection(name)` returns a synchronous handle. `getAsyncCollection(name)` returns an asynchronous handle directly, without I/O. Both expose CRUD, queries, sorting, exact/text indexes, index inspection/removal, text search, `reindex`, and collection plugins. Async operations return promises, including methods that return a handle for chaining. Use `await` before chaining their results.

Node and Bun both expose these pairs: `load`/`asyncLoad`, `save`/`asyncSave`, `reload`/`asyncReload`, `transaction`/`asyncTransaction`, `snapshot`/`asyncSnapshot`, and `close`/`asyncClose`. Using `await` on a synchronous method does not change its execution mode. Synchronous operations reject with `BUSY` while asynchronous work is pending.

### Persist a database as JSON in Node.js

Select the `node-json` adapter per instance, then explicitly load a destination. Creating the instance performs no I/O:

```ts
import IluDB from "iludb";
import nodeJSON from "iludb/plugins/node-json";

const database = IluDB({ adapter: nodeJSON });
database.load("./data/database.json");
const sessions = database.getCollection("sessions");

sessions.add({ userId: 42, state: "active" });
database.close();
```

`load()` validates an existing snapshot or creates a new one at revision `0`, including missing parent directories. Collections are available after loading. `add`, `update`, and `remove` commit automatically. `close()` stops watching and performs no additional save.

### Persist a database as JSON in Bun

The `bun-json` adapter requires Bun and exposes the same synchronous and asynchronous API as `node-json`:

```ts
import IluDB from "iludb";
import bunJSON from "iludb/plugins/bun-json";

const database = IluDB({ adapter: bunJSON });
await database.asyncLoad("./data/database.json");
const tasks = database.getAsyncCollection<{ title: string; status: string }>("tasks");

try {
  const task = await tasks.add({ title: "Ship the prototype", status: "open" });
  await tasks.update({ ...task, status: "done" });
  const completed = await tasks.find({ status: "done" });
  console.log(completed);
} finally {
  await database.asyncClose();
}
```

TypeScript CommonJS consumers can use `import bunJSON = require("iludb/plugins/bun-json")`. JavaScript consumers use `require` directly. Default imports rely on CommonJS interoperability.

### Persist in browser localStorage

Load an origin-scoped key and use synchronous collection methods:

```ts
import IluDB from "iludb";
import localStorageAdapter from "iludb/plugins/local-storage";

const database = IluDB({ adapter: localStorageAdapter });
database.load("my-app:tasks");
database.getCollection("tasks").add({ title: "Publish" });
database.close();
```

The destination is a key, not a file path. A complete JSON snapshot occupies one key. Unrelated keys are untouched. localStorage exposes only synchronous database/collection methods in both runtime and inferred TypeScript types. There are no async stubs.

Storage can be denied or cleared by the browser or user. The plain in-memory `IluDB()` remains usable even where storage is denied. See [localStorage behavior and limits](#localstorage-behavior-and-limits) for watching, rollback, and storage constraints.

Continue with the [collection API](#essential-collection-api) to query and update documents, or [transactions](#commit-related-changes-in-a-transaction) to publish related persistent changes together.

## Limits to consider

- Data lives in process memory unless a runtime-specific JSON adapter persists it.
- Queries use direct fields and strict equality. IluDB does not provide MongoDB-style operators or nested field paths.
- Text search covers normalized whole words with `AND` and `OR`. It has no fuzzy search, ranking, stemming, or prefix search.
- Runtime indexes consume memory and increase the work required for indexed writes.
- Direct mutation of `database.data` bypasses automatic index maintenance and JSON saves.
- Node/Bun sync methods and localStorage can block the main thread. Node/Bun async methods await filesystem I/O, but cloning, serialization, validation, and index rebuilding still run synchronously in memory.
- On filesystems that support atomic same-directory replacement, readers do not see a partial JSON file. The plugin does not promise physical durability across sudden power loss.
- Revision conflicts detect stale snapshots without providing locks, merge, retries, or safe multiwriter coordination. Use one writer and any number of readers.

## Essential collection API

The table describes synchronous in-memory collections. Persistent collections commit mutations automatically, reject invalid additions, and return `null` for missing documents from `get` and `findOne`. See the [persistence reference](#persistence-reference) for those differences. Async handles expose the corresponding operations as promises.

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

Persistent databases expose isolated `snapshot()` copies instead of mutable `data`. Use their collections or transactions to change stored documents.

## Persistence reference

The examples above cover opening a database and storing documents. This section describes the contracts for loading, committing, reloading, and closing persistent databases.

### Loading and persistent collections

`load()` validates an existing snapshot or creates a new one at revision `0`, including missing parent directories for filesystem adapters. localStorage uses a key instead of a path. A failed first load permits another attempt. After a successful load the destination is fixed. Use `reload()` to read it again. Collections are available after loading.

`add`, `update`, and `remove` commit automatically. Each stages isolated changes and publishes memory only after persistence succeeds. Invalid additions throw. Missing documents from `get` and `findOne` return `null` in persistent collections, including transaction collections. The in-memory core retains its existing `undefined` behavior.

### Synchronous saves and atomic replacement

This filesystem contract applies to Node and Bun. localStorage publishes through `setItem`, as described in [localStorage behavior and limits](#localstorage-behavior-and-limits).

`save()` is synchronous and increments the revision even without document changes. Serialization and filesystem errors propagate before it returns. `asyncSave()` uses asynchronous filesystem I/O. Both retain the active state and revision when publication fails.

The plugin writes a unique temporary file in the destination directory, calls `fsync` on its file descriptor, and publishes it with `rename`. On filesystems that support atomic same-directory replacement, readers do not observe a partially written JSON document. Existing POSIX mode bits are preserved.

This contract covers visible atomic replacement. The plugin does not call `fsync` on the parent directory, so it does not guarantee that the rename survives sudden power loss. Ownership, ACLs, and extended attributes are outside the persistence contract.

### Revisions and conflicts

Every persisted snapshot has a non-negative `revision`. For filesystem adapters, `save()` compares the revision on disk with the revision loaded by the current database instance before writing. With an open Node database:

```ts
try {
  database.save();
} catch (error) {
  if (error instanceof nodeJSON.ConflictError) {
    console.error(error.expectedRevision, error.actualRevision);
  } else {
    throw error;
  }
}
```

A mismatch throws the adapter's `ConflictError`. Its `expectedRevision` contains the loaded revision and `actualRevision` contains the stored revision (`null` when the destination disappeared). A rejected mutation or transaction discards its staged changes and does not advance the local revision.

Revision checks detect stale snapshots, but a time-of-check/time-of-use gap remains because the plugin has no lock or multiwriter protocol. Use one writer and any number of readers. IluDB does not merge, retry, or resolve conflicts.

Legacy files without `revision` load as revision `0`. Their next successful save publishes revision `1`.

### Transactional reload

```ts
database.reload();
```

`reload()` synchronously reads, validates, and stages the complete snapshot before replacing active state. `asyncReload()` is its asynchronous counterpart. A failed reload preserves active data, indexes, and revision.

Existing synchronous handles remain usable when their named collection survives a reload. Removed collections make those handles inactive until explicitly recreated. Index definitions survive for collections present in the replacement. Indexes remain in memory and are not persisted.

### Watch external replacements

For an open Node or Bun database, watch the file for external changes:

```ts
database.watch({
  interval: 500,
  onReload(reloaded) {
    void reloaded.asyncSnapshot().then((snapshot) => console.log(snapshot.revision));
  },
  onError(error) {
    console.error(error.message);
  }
});

database.unwatch();
```

Filesystem `watch()` uses `fs.watchFile`, defaults to `500` milliseconds with `persistent: false`, and queues asynchronous reloads. Both callbacks are optional. Callbacks must not assume the synchronous API is available while queued operations remain.

Invalid or deleted files leave the active snapshot intact while the watcher waits for another file signature. Saves from the same database instance update the watch baseline and do not call `onReload`. A second active `watch()` call has no effect. `unwatch()` is idempotent.

The destination cannot be retargeted. `close()` cancels watching and requires no pending operations. `asyncClose()` stops admission and watching, then waits for admitted operations. Both are idempotent and perform no additional save.

### Date behavior in JSON

On load, the plugin restores IluDB metadata timestamps as `Date` instances:

- `createdAt` and `modifiedAt` on the database and collections
- `$createdAt` and `$modifiedAt` on documents

These timestamps must contain the canonical ISO string produced by `Date#toJSON` or `Date#toISOString`. Missing or invalid metadata rejects the snapshot. Revisions and document IDs must be safe integers in their valid ranges, with unique IDs per collection.

User fields follow standard JSON semantics. An ISO string stays a string. A user-supplied `Date` serializes to an ISO string and reloads as a string.

### Bun runtime APIs

Bun reads snapshot contents with `Bun.file(fd).text()`, writes with `Bun.write`, and removes temporary files through `Bun.file().delete()` in its asynchronous path. Node-compatible APIs provide descriptor flags, stable-read checks, mode preservation, synchronization, links/rename, directories, and watching. Synchronous operations use synchronous filesystem APIs because Bun's content readers and `Bun.write` return promises. These exceptions preserve the required safety and synchronous completion guarantees. No measured speed advantage is claimed.

### Commit related changes in a transaction

`add`, `update`, and `remove` each commit automatically. Use `transaction()` for synchronous persistence or `asyncTransaction()` in Node/Bun to publish several changes in one snapshot. In the Bun example, place this operation inside the `try` block, before the database closes:

```ts
await database.asyncTransaction((tx) => {
  const tasks = tx.getCollection<{ title: string; status: string }>("tasks");
  tasks.add({ title: "Write release notes", status: "open" });
  tasks.add({ title: "Publish the package", status: "open" });
});
```

Both transaction callbacks must be synchronous. Async callbacks and returned thenables are rejected. Do external async work first and use only `tx` collection handles inside the callback. Reentry through external collection handles is rejected. `snapshot()` may inspect the committed state during a callback, never its stage. Transaction handles expire when the callback finishes. Returned values must support `structuredClone` and are detached from committed state.

In Node and Bun, operations queue within each open database instance. A transaction stages changes and publishes them only after serialization, validation, revision checks, and file replacement succeed. localStorage transactions publish after `setItem` succeeds. A rejected transaction leaves the active snapshot unchanged. Index definitions remain in memory and are rebuilt for surviving collections across commits and reloads. They are not persisted.

### Snapshots, errors, and lifecycle

- `snapshot()` returns an isolated copy. `asyncSnapshot()` observes earlier admitted operations through the queue.
- An asynchronous operation captures its document/query arguments at admission. Later changes to the input do not change the admitted work.
- Synchronous operations reject with `BUSY` while asynchronous work is pending. Use the async counterpart or wait for the outstanding work.
- A failed queued operation does not prevent later admitted operations from running.

Persistence errors expose codes `INVALID_INPUT`, `INVALID_SNAPSHOT`, `CONFLICT`, `IO`, `CLOSED`, and `BUSY`. The adapter exports `PersistenceError` and `ConflictError`. Callback and serialization errors can propagate unchanged. Handle conflicts by explicitly deciding whether to reload and retry.

Both filesystem adapters reject symlinks and nonregular destinations, create restrictive new files (`0600`) and parent directories (`0700`, subject to umask), and preserve existing POSIX file mode bits on replacement. Ownership, ACLs, extended attributes, and parent-directory synchronization are outside the contract.

Revision checks detect stale snapshots, but the check and replacement are separate operations. The queue coordinates only one database instance. Use one writer per file, including across instances in the same process. The plugin has no lock, merge, automatic retry, or safe multiwriter protocol.

### localStorage behavior and limits

Quota or access failures preserve the active snapshot and revision. Transactions publish memory only after `setItem` succeeds.

`watch()` listens for real `storage` events from other same-origin documents and internal notifications from other adapter sessions in the same document. Notifications during a protected operation are deferred until it finishes. Direct localStorage writes in the same document require explicit `reload()`. Invalid/deleted values preserve active state. Canceling watching or closing prevents new automatic reloads.

Storage is scoped by browser origin, is shared with scripts of that origin, can be denied, and can be cleared by the browser or user. It has no filesystem permissions, fsync, or multiwriter transaction guarantee. Use one writer per key. Data cloning and localStorage access block the main thread. Importing the adapter does not access storage. The plain in-memory `IluDB()` remains usable even where storage is denied.

## Migrate from earlier persistence APIs

This API intentionally removes `IluDB(path)`, `IluDB.getDatabase(path)`, global registration of JSON plugins, and `IluDB.openBunJSON(path)`. Migrate to `IluDB({ adapter })` followed by `load` or `asyncLoad`. Use `snapshot()` instead of persistent `data`, and a new instance instead of changing `dir`. Legacy JSON snapshots without `revision` load as revision `0` in all adapters. Their next commit advances to `1`.

## Custom adapter contract

Connect your storage backend to IluDB without rebuilding its collection API. Your adapter opens storage sessions, reads and publishes complete JSON snapshots, and reports changes. IluDB's shared controller handles JSON validation, transactions, queues, and indexes.

The synchronous contract consists of a factory with `open(destination)` and a session with `read`, `write({ serialized, expectedRevision })`, and cancelable `subscribe`. An `AsyncAdapter` adds `asyncRead` and `asyncWrite`, and its factory declares `asynchronous: true`. The tutorial below starts with the synchronous contract.

### Build your first adapter

Build a synchronous adapter, store a task, and read it from a second database instance. Then use `watch()` to make the reader observe another committed change. Your collection code stays the same. The adapter supplies the storage boundary, while IluDB handles documents, metadata, queries, indexes, transaction staging, and JSON serialization.

The example uses a shared `Map`, so you need no filesystem or external service. Snapshots remain available when you close and reopen database instances using the same adapter object within the running process. They do **not** survive a process restart. For ordinary in-memory data, use `IluDB()` directly. Use this adapter to learn the contract before connecting a different backend.

#### 1. Separate the factory from each session

One factory can open several sessions. Each session is bound to a destination, such as the `"tutorial:tasks"` key used below. Sessions for that destination share stored data but keep their own subscriptions.

The public types are available through the `IluDB` namespace. Implement these four methods:

| Type or method                               | Your responsibility                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IluDB.AdapterFactory.open(destination)`     | Return a session bound to one destination. Do not overwrite or create its snapshot here. IluDB calls this during `load`, not during database construction.        |
| `IluDB.Adapter.read()`                       | Return the complete JSON string, or `null` only when the destination is absent. Throw on access or backend errors instead of treating them as an empty database.  |
| `IluDB.Adapter.write(input)`                 | Check `input.expectedRevision`, then publish `input.serialized` completely before returning. A failed publication must leave the previous stored snapshot intact. |
| `IluDB.Adapter.subscribe(onChange, options)` | Observe changes to this destination and return an idempotent unsubscribe function. Event-driven storage can ignore `options.interval`.                            |

The revision check determines whether a write may replace the stored value. `write` receives a controller-validated snapshot, but your backend must check the revision of the **currently stored** snapshot before publishing it:

- `expectedRevision: null` requires an absent destination, so creation must not overwrite an existing snapshot.
- A numeric `expectedRevision` requires an existing snapshot with that exact revision.
- A missing revision in a legacy snapshot means `0`.

#### 2. Implement a synchronous backend

In a project with IluDB installed, save the following complete adapter as `custom-adapter.ts`. The two maps hold serialized snapshots and change listeners by destination. Each `open` call returns a new session over that shared state:

```ts
import IluDB from "iludb";

class RevisionConflictError extends Error {
  readonly code = "CONFLICT";

  constructor(
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super("The stored snapshot revision changed.");
    this.name = "RevisionConflictError";
  }
}

const snapshots = new Map<string, string>();
const subscriptions = new Map<string, Set<() => void>>();

const memoryAdapter: IluDB.AdapterFactory = {
  open(destination): IluDB.Adapter {
    const listeners = subscriptions.get(destination) ?? new Set<() => void>();
    subscriptions.set(destination, listeners);
    let ownListener: (() => void) | null = null;

    return {
      read() {
        return snapshots.get(destination) ?? null;
      },
      write({ serialized, expectedRevision }) {
        const current = snapshots.get(destination) ?? null;
        let actualRevision: number | null = null;

        if (current !== null) {
          const stored = JSON.parse(current);
          const revision = Object.hasOwn(stored, "revision") ? stored.revision : 0;
          if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new Error("Invalid stored snapshot revision.");
          }
          actualRevision = revision;
        }

        if (actualRevision !== expectedRevision) {
          throw new RevisionConflictError(expectedRevision, actualRevision);
        }

        snapshots.set(destination, serialized);

        for (const listener of [...listeners]) {
          if (listener === ownListener) {
            continue;
          }
          try {
            listener();
          } catch {
            // Notification failure must not reject an already committed write.
            console.error("An adapter change listener failed.");
          }
        }
      },
      subscribe(onChange) {
        ownListener = onChange;
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
          if (ownListener === onChange) {
            ownListener = null;
          }
        };
      }
    };
  }
};
```

Follow the write path in the example: read the stored revision, reject a mismatch, replace the stored string, and notify the other sessions. Publication happens at `snapshots.set`. A listener failure after that point must not turn the completed write into a reported commit failure.

`RevisionConflictError` is defined in this file. Custom adapters may define their own error classes. Let backend errors propagate, or wrap them with a useful message and `cause`. A failed write must not return success. A conflict must not trigger deletion of a newer snapshot.

#### 3. Connect it and reuse your collection code

Append the following code to the same file. It opens a writer, stores a task, and opens a reader against the same destination. The reader then watches for the writer's next commit. Both instances close in `finally`:

```ts
type CustomTask = { title: string };

const writer = IluDB<CustomTask>({ adapter: memoryAdapter });
const reader = IluDB<CustomTask>({ adapter: memoryAdapter });

try {
  writer.load("tutorial:tasks");
  writer.getCollection("tasks").add({ title: "Build an adapter" });

  reader.load("tutorial:tasks");
  console.log(reader.getCollection("tasks").count()); // 1

  reader.watch({
    onReload(reloaded) {
      console.log(reloaded.snapshot().revision);
    }
  });

  writer.getCollection("tasks").add({ title: "Reuse the collection API" });
  // onReload prints revision 2.
  console.log(reader.getCollection("tasks").count()); // 2
} finally {
  reader.close();
  writer.close();
}
```

Run the file with Bun:

```sh
bun run custom-adapter.ts
```

Read the output in order: the reader first counts one task, `onReload` reports revision `2`, and the final count is two tasks. The comments in the example identify those expected results.

Reusing `memoryAdapter` gives both instances access to the same snapshot store. Each `open` call still creates a separate session, allowing notifications to exclude the writer. When notified, the controller rereads and validates the stored snapshot. Your adapter signals that storage changed. The controller decides whether the new snapshot is valid.

The unsubscribe function removes the listener. Stop delivering new notifications after unsubscribe, and keep notification failures separate from the outcome of a completed write.

The example uses one writer. If another instance attempts a write with a stale revision, this adapter throws `RevisionConflictError`. Catch it around the mutation, inspect the active state, and explicitly decide whether to `reload()` before trying again. IluDB does not retry or merge automatically.

#### 4. Add async support only when your backend supports it

Keep the Map adapter synchronous. For a backend that supports both modes, type the factory as `IluDB.AsyncAdapterFactory`, set its literal `asynchronous: true` property, and return an `IluDB.AsyncAdapter` session. Keep the three synchronous session methods and add:

- `asyncRead(): Promise<string | null>`, with the same missing-destination and error rules as `read`.
- `asyncWrite(input: IluDB.WriteSnapshot): Promise<void>`, with the same revision checks and publication guarantees as `write`.

Both modes must use the same destination and storage state. The factory type lets TypeScript infer `asyncLoad`, `getAsyncCollection`, and the other async database methods. The runtime uses `asynchronous: true` to expose them. For a synchronous-only backend, keep `IluDB.AdapterFactory` and omit the marker, as this example and the built-in localStorage adapter do.

The current async contract **extends the synchronous contract**. An async-only service cannot implement it by omitting the synchronous methods. Likewise, `Promise.resolve(session.read())` does not turn a blocking backend into nonblocking I/O. The Map example deliberately stays synchronous.

#### Before using a different storage backend

You now have the full synchronous storage boundary: opening a session, reading, revision-checked publication, and cancelable notifications. When replacing the maps with your backend, preserve these contracts and document the guarantees that backend actually provides:

- Preserve the entire JSON snapshot, including revisions and metadata. Let the controller restore its timestamps and validate loaded documents. A fresh destination needs no hand-written initial JSON: `load()` creates revision `0` through your session's `write` method.
- Establish your backend's publication boundary. Failures before publication must retain the old stored value. Do not report a failed commit solely because a notification or post-commit cleanup failed after storage accepted it.
- Treat storage content as untrusted. Reject malformed revisions during a write check and preserve corrupt stored content rather than silently replacing it. Surface access, quota, and backend errors to the caller.
- Use one writer per destination unless the backend supplies a stronger, explicitly implemented coordination protocol. A revision read followed by a write is not an atomic compare-and-swap across processes or clients.
- Describe durability and watching as properties of your backend. The Map example only notifies sessions sharing its own subscription registry. It provides neither cross-process events nor disk durability. Filesystem permissions and `fsync` are not universal adapter guarantees.

## Environments, formats, and types

The package exports four public entrypoints:

- `iludb` for the in-memory core
- `iludb/plugins/node-json` for Node.js JSON persistence
- `iludb/plugins/bun-json` for synchronous/asynchronous Bun JSON persistence
- `iludb/plugins/local-storage` for synchronous browser persistence

The core ships as readable and minified UMD bundles. They support CommonJS and AMD and expose `IluDB` as a global when loaded in a compatible global runtime. The default import shown above relies on CommonJS interoperability in Node.js ESM or a bundler. IluDB does not ship a native ESM bundle. Package metadata points browser consumers to the minified core bundle.

Adapters use UMD and expose globals `IluDBNodeJSONPlugin`, `IluDBBunJSONPlugin`, and `IluDBLocalStorageAdapter`. The filesystem adapters externalize Node filesystem, path, and crypto modules. Bun additionally requires its native runtime. The core and localStorage adapter have no filesystem dependencies.

TypeScript declarations ship for all entrypoints. Adapter selection infers `SyncDatabase` for localStorage and `AsyncDatabase` (including sync methods) for Node/Bun. They share collection, snapshot, transaction, revision, and watch types.

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

Run the browser persistence tests with Playwright Test:

```sh
bun run test:browser
bun run test:browser --grep quota-rollback
```

This command builds the bundles, then runs the ten browser cases in headless Google Chrome using `@playwright/test`. Google Chrome must already be installed (the configuration uses the `chrome` channel). The runner does not download browsers. It reports each case and returns a nonzero exit code on failure. Each test gets an isolated browser context and exercises real localStorage, quota, access restrictions, and same-origin document events.

A worker fixture starts `test/browser-server.ts` on a system-assigned loopback port and sends SIGTERM only to its own recorded server PID during teardown. Playwright manages the dedicated browser lifecycle. The page and `test/persistent-browser.js` retain the browser-side business scenarios, while `test/persistent-browser.spec.ts` controls their execution and failure reporting. Browser cases remain separate from `bun run test`, which continues to run only the existing Bun suites.

### Build a vendored package

```sh
bun run build --vendor-dir ./tmp/vendor/iludb
```

Place `--vendor-dir` immediately before its destination as shown. The build first regenerates `dist`, then copies the package manifest, license, README, and readable/minified bundles and declarations for all four entrypoints into that directory. The copied manifest omits contributor scripts and dev dependencies and retains package exports, so the directory can serve as a local package. Consumers still need Bun to use `bun-json`.

Use a dedicated destination. Matching files are overwritten, and unrelated existing files are not removed. This option copies a package directory rather than producing an npm tarball or installing dependencies.

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

## License

Apache-2.0
