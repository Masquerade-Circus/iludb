# IluDb

IluDb is a minimal in-memory database for Node.js and the web.

It is inspired by [`LokiJS`](http://lokijs.org) but will mantain a minimal api with a small footprint.

So, no mongo like queries as it is, but plugins are welcome. IluDb have a plugin system for extensibility.

# Usage

The package publishes readable and minified UMD bundles. Both variants support
CommonJS and AMD, and expose `IluDB` as a global when the runtime permits it.

## Collection API

Documents are plain objects composed of primitives, arrays, nested plain objects
and dates. IluDB returns isolated copies so changes to a result do not alter
stored data.

- `add(document)` stores a document, assigns `$id`, `$createdAt` and
  `$modifiedAt`, and returns a copy. Reserved metadata fields are rejected.
- `get(id)` returns a copy of the document whose `$id` strictly equals `id`, or
  `undefined` when it does not exist.
- `find(query?, options?)` returns copies of all documents whose fields
  strictly equal every field in the plain-object query. An empty query matches
  all documents. `options.sort` accepts direct field names with `1` for
  ascending order and `-1` for descending order.
- `findOne(query?, options?)` applies the same query and sort contract and
  returns the first copy, or `undefined` when no document matches.
- `sort(array, options?)` returns the array unchanged when no sort fields exist.
  Otherwise it returns a stable sorted copy using direct field names and `1` or
  `-1` directions.
- `update(document)` finds the stored `$id`, applies the document's own fields
  except reserved metadata, refreshes `$modifiedAt`, and returns a copy. It
  throws when the `$id` does not exist.
- `count(query?)` counts documents with the same plain-object query contract.
- `remove(document)` removes the document whose `$id` strictly equals the
  supplied `$id`. It throws when the `$id` does not exist.

## Exact indexes

Exact indexes accelerate the strict-equality contract already used by `find`
and `findOne`. A simple index uses one direct field. A compound index uses every
declared direct field and keeps each value as its own `Map` key.

```ts
const users = database.getCollection("users");

users.createIndex("by-email", "email");
users.createIndex("by-tenant-status", ["tenantId", "status"]);

users.find({ tenantId: 7, status: "active" });
users.getIndexes();
users.dropIndex("by-email");
```

`find` and `findOne` choose a covered index automatically. The collection
prefers the index with the most fields, then the posting with the fewest
candidates. Every candidate still passes the full query. Results keep the
collection order unless `sort` requests another order. Queries without a
covered index use the existing linear scan. An empty query matches every
document.

Index names and field names must be non-empty trimmed strings. Field lists must
contain unique names. A document missing any indexed field receives no posting
for that exact index. Duplicate names across exact and text indexes throw.
Dropping a missing index returns `false`.

## Text indexes

Text indexes cover several direct string fields with whole-word search.

```ts
articles.createTextIndex("content", ["title", "body"]);

articles.searchText("content", "database indexes");
articles.searchText("content", "database cache", { operator: "OR" });
articles.getTextIndexes();
articles.dropTextIndex("content");
```

The default `AND` operator requires every token. `OR` returns documents that
contain at least one token without duplicates. Tokenization applies Unicode
NFKD normalization, removes combining marks, converts text to lowercase and
splits on non-alphanumeric characters. Repeated tokens in one document create
one posting. Missing fields and non-string values contribute no tokens. Input
that produces no tokens returns an empty array. Unknown index names and invalid
operators throw.

Exact and text indexes exist only in runtime memory. IluDB builds a new index
once when it is declared and keeps it synchronized through `add`, `update` and
`remove`. Index definitions and postings never enter the JSON plugin payload.
Direct mutation of `database.data` bypasses synchronization and can leave
indexes stale. Call `collection.reindex()` after direct mutations to rebuild all
declared exact and text indexes from the collection's current data. The method
preserves the current array order and index definitions, updates every wrapper
that shares the collection data, and returns the collection for chaining. It
builds replacement state before publishing it, so an error leaves the previous
index state intact. IluDB does not detect direct mutations or rebuild indexes
automatically.

## JSON persistence

Install the Node JSON plugin and pass a JSON file path when creating the
database.

```ts
const IluDB = require("iludb");
const jsonPlugin = require("iludb/plugins/node-json");

IluDB.use(jsonPlugin);
const database = IluDB("./data/database.json");
```

`save()` serializes the current database state and publishes it synchronously
through a unique temporary file in the same directory, descriptor `fsync` and
atomic `rename`. Existing POSIX mode bits are preserved. The rename prevents
readers from observing a partial JSON file. IluDB does not `fsync` the parent
directory, so the API does not promise that the rename survives sudden power
loss. Ownership, ACLs and extended attributes are outside this contract.

Each persisted snapshot has a non-negative `revision`. Legacy files without the
field load as revision 0 and the next successful save publishes revision 1.
Before creating a temporary file, `save()` compares the disk revision with the
revision that this instance loaded. A mismatch throws
`nodeJSONPlugin.ConflictError`, whose `expectedRevision` and `actualRevision`
properties identify the conflict. `actualRevision` is `null` when the loaded
destination disappeared. The failed save preserves local changes and does not
advance the local revision.

This check detects stale snapshots, but it has a time-of-check/time-of-use gap
because IluDB provides no lock or multiwriter protocol. Use one writer and any
number of readers. IluDB performs no merge, retry or conflict resolution.

`add`, `update` and `remove` call `save()` automatically, so their JSON changes
reach the file before those methods return. Serialization and filesystem errors
propagate synchronously to the caller. Call `save()` after mutating
`database.data` directly. Runtime exact and text indexes remain excluded from
the JSON payload.

`reload()` synchronously validates and stages the complete file before it
publishes the replacement snapshot. A successful reload discards unsaved local
changes. A failed reload preserves the current data reference, collection
wrappers, index state and loaded revision. Existing wrappers remain usable when
their named collection survives. A removed collection makes all of its wrappers
inactive until `getCollection(name)` recreates it or a later reload restores it.
Operations on an inactive wrapper throw. Direct references to prior data
objects, collection objects, arrays or documents can become stale after reload.

`watch()` uses `fs.watchFile` with a 500 ms default interval and
`persistent: false`. It reloads valid external replacements automatically and
accepts optional `onReload` and `onError` callbacks. Invalid or deleted files
leave the current snapshot intact while the watcher waits for a new file
signature. Saves from the same database instance update the watch baseline and
do not call `onReload`. A second active `watch()` call has no effect.
`unwatch()` is idempotent. Changing `database.dir` does not retarget an active
watcher. Stop it and start it again to watch the new path.

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

On load, the plugin restores only IluDB's own timestamps: `createdAt` and
`modifiedAt` on the database and collections, plus `$createdAt` and
`$modifiedAt` on documents. Every timestamp is required and must contain the
canonical ISO string produced by `Date#toJSON` or `Date#toISOString`. Missing or
invalid metadata stops the load with a `TypeError` that identifies its exact
path.

The plugin uses standard JSON semantics for every user field. An ISO string in
user data remains a string. A user-supplied `Date` serializes to an ISO string
and reloads as a string. The plugin does not apply a global date reviver, and
the JSON format on disk remains unchanged.

The Node JSON plugin ships with the same readable and minified UMD distribution
shape as the core. It externalizes Node's `fs` module and therefore requires a
Node-compatible runtime. Loading it in a browser without `fs` fails by design.

# Build/Test

Install dependencies with `bun install --frozen-lockfile`.

Type-check the TypeScript sources with `bun run typecheck`.

Build all JavaScript artifacts with `bun run build`.

Build and run the TypeScript tests with `bun run test`.

Build and run the fixed-workload benchmark with `bun run bench`.
It reports the median and range from five measured samples by default. Set
`BENCH_SAMPLES` to an integer of at least three and `BENCH_TARGET_MS` to the
approximate total measured duration per operation.
The workload includes index reconstruction plus atomic JSON save and reload at
100 and 1,000 documents without enforcing a performance threshold. Persistence
reload measurements retain one exact index and one text index, use
`BENCH_SAMPLES`, and report the median and range.

Set `BENCH_BASELINE` to another bundle path to execute the same workload against
the baseline and print the throughput ratio for every operation.
