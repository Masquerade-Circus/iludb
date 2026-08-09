import { mkdirSync, mkdtempSync } from "fs";
import { join, resolve } from "path";
import type IluDbSource from "../src/index";
import nodeJSONPlugin from "../src/plugins/node-json";

const DATASET_SIZE = 1_000;
const WARM_UP_ITERATIONS = 3;
const CALIBRATION_MIN_MS = 200;
const TARGET_MS = Number(process.env.BENCH_TARGET_MS ?? 1_000);
const SAMPLE_COUNT = Number(process.env.BENCH_SAMPLES ?? 5);
const currentBundle = resolve(process.argv[2] ?? "dist/iludb.min.js");
const baselineBundle =
  typeof process.env.BENCH_BASELINE === "string"
    ? resolve(process.env.BENCH_BASELINE)
    : typeof process.argv[3] === "string"
      ? resolve(process.argv[3])
      : null;

if (!Number.isFinite(TARGET_MS) || TARGET_MS <= 0) {
  throw new Error("BENCH_TARGET_MS must be a positive number.");
}
if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 3) {
  throw new Error("BENCH_SAMPLES must be an integer of at least 3.");
}

type IluDbStatic = typeof IluDbSource;
type Collection = ReturnType<ReturnType<IluDbStatic>["getCollection"]>;
type Database = ReturnType<IluDbStatic>;
type Context = {
  IluDb: IluDbStatic;
  database: Database;
  collection: Collection;
  indexedCollection: Collection;
  textCollection: Collection;
  rareCollection: Collection;
  rareTextCollection: Collection;
  reindexSmallCollection: Collection;
  reindexLargeCollection: Collection;
  document: Record<string, any>;
  indexedDocument: Record<string, any>;
  textDocument: Record<string, any>;
  rareDocument: Record<string, any>;
  rareTextDocument: Record<string, any>;
  documents: Record<string, any>[];
  updateDocument: Record<string, any>;
  supportsTextIndexes: boolean;
  supportsReindex: boolean;
};
type Benchmark = {
  name: string;
  run(context: Context, iterations: number): void;
  supported?(context: Context): boolean;
};

function noopPlugin(): void {}

function supportsTextIndexes(context: Context): boolean {
  return context.supportsTextIndexes;
}

function supportsReindex(context: Context): boolean {
  return context.supportsReindex;
}

function createContext(IluDb: IluDbStatic): Context {
  const database = IluDb("benchmark");
  const collection = database.getCollection("records");
  const indexedCollection = database.getCollection("indexed-records");
  const textCollection = database.getCollection("text-records");
  const rareCollection = database.getCollection("rare-records");
  const rareTextCollection = database.getCollection("rare-text-records");
  const reindexSmallCollection = database.getCollection("reindex-small");
  const reindexLargeCollection = database.getCollection("reindex-large");
  for (let index = 0; index < DATASET_SIZE; index += 1) {
    let body = index % 2 === 0 ? "common even" : "common odd";
    if (index === DATASET_SIZE - 2) {
      body += " scarce";
    } else if (index === DATASET_SIZE - 1) {
      body += " rare tail";
    }
    const document = {
      group: index % 10,
      score: DATASET_SIZE - index,
      active: index % 2 === 0,
      body
    };
    collection.add({ ...document });
    indexedCollection.add({ ...document });
    textCollection.add({ ...document });
    const rareDocument = { body: `unique${index}` };
    rareCollection.add({ ...rareDocument });
    rareTextCollection.add({ ...rareDocument });
    reindexLargeCollection.add({ ...document });
    if (index < 100) {
      reindexSmallCollection.add({ ...document });
    }
  }
  if (typeof indexedCollection.createIndex === "function") {
    indexedCollection.createIndex("by-active", "active");
    indexedCollection.createIndex("by-group", "group");
    indexedCollection.createIndex("by-score", "score");
    reindexSmallCollection.createIndex("by-group", "group");
    reindexLargeCollection.createIndex("by-group", "group");
  }
  const supportsTextIndexes = typeof textCollection.createTextIndex === "function";
  const supportsReindex = typeof reindexSmallCollection.reindex === "function";
  if (supportsTextIndexes) {
    textCollection.createTextIndex("body", "body");
    rareTextCollection.createTextIndex("body", "body");
  }
  IluDb.use(noopPlugin);
  database.use(noopPlugin);
  collection.use(noopPlugin);
  const document = collection.get(DATASET_SIZE)!;
  const indexedDocument = indexedCollection.get(DATASET_SIZE)!;
  const textDocument = textCollection.get(DATASET_SIZE)!;
  const rareDocument = rareCollection.get(DATASET_SIZE)!;
  const rareTextDocument = rareTextCollection.get(DATASET_SIZE)!;
  return {
    IluDb,
    database,
    collection,
    indexedCollection,
    textCollection,
    rareCollection,
    rareTextCollection,
    reindexSmallCollection,
    reindexLargeCollection,
    document,
    indexedDocument,
    textDocument,
    rareDocument,
    rareTextDocument,
    documents: collection.find(),
    updateDocument: { ...document, score: 1 },
    supportsTextIndexes,
    supportsReindex
  };
}

function runDatabase(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.IluDb("benchmark");
  }
}

function runCreateDatabaseAndCollection(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.IluDb("benchmark").getCollection("records");
  }
}

function runGetCollection(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.database.getCollection("records");
  }
}

function runGetCollectionStatic(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.IluDb.getCollection(context.database, "records");
  }
}

function runSort(context: Context, iterations: number): void {
  const options = { group: 1, score: -1 } as const;
  for (let index = 0; index < iterations; index += 1) {
    context.collection.sort(context.documents, options);
  }
}

function runFind(context: Context, iterations: number): void {
  const query = { active: true };
  for (let index = 0; index < iterations; index += 1) {
    context.collection.find(query);
  }
}

function runFindIndexedHalf(context: Context, iterations: number): void {
  const query = { active: true };
  for (let index = 0; index < iterations; index += 1) {
    context.indexedCollection.find(query);
  }
}

function runFindTenth(context: Context, iterations: number): void {
  const query = { group: 5 };
  for (let index = 0; index < iterations; index += 1) {
    context.collection.find(query);
  }
}

function runFindIndexedTenth(context: Context, iterations: number): void {
  const query = { group: 5 };
  for (let index = 0; index < iterations; index += 1) {
    context.indexedCollection.find(query);
  }
}

function runFindRare(context: Context, iterations: number): void {
  const query = { score: 1 };
  for (let index = 0; index < iterations; index += 1) {
    context.collection.find(query);
  }
}

function runFindIndexedRare(context: Context, iterations: number): void {
  const query = { score: 1 };
  for (let index = 0; index < iterations; index += 1) {
    context.indexedCollection.find(query);
  }
}

function runSearchTextAndHigh(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.textCollection.searchText("body", "common even");
  }
}

function runSearchTextAndLow(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.textCollection.searchText("body", "rare tail");
  }
}

function runSearchTextOrHigh(context: Context, iterations: number): void {
  const options = { operator: "OR" } as const;
  for (let index = 0; index < iterations; index += 1) {
    context.textCollection.searchText("body", "even odd", options);
  }
}

function runSearchTextOrLow(context: Context, iterations: number): void {
  const options = { operator: "OR" } as const;
  for (let index = 0; index < iterations; index += 1) {
    context.textCollection.searchText("body", "rare scarce", options);
  }
}

function runFindSorted(context: Context, iterations: number): void {
  const query = { active: true };
  const options = { sort: { score: 1 } } as const;
  for (let index = 0; index < iterations; index += 1) {
    context.collection.find(query, options);
  }
}

function runFindOne(context: Context, iterations: number): void {
  const query = { score: 1 };
  for (let index = 0; index < iterations; index += 1) {
    context.collection.findOne(query);
  }
}

function runFindOneSorted(context: Context, iterations: number): void {
  const query = { group: 5 };
  const options = { sort: { score: 1 } } as const;
  for (let index = 0; index < iterations; index += 1) {
    context.indexedCollection.findOne(query, options);
  }
}

function runGet(context: Context, iterations: number): void {
  const id = context.document.$id;
  for (let index = 0; index < iterations; index += 1) {
    context.collection.get(id);
  }
}

function runUpdate(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.collection.update(context.updateDocument);
  }
}

function runUpdateIndexed(context: Context, iterations: number): void {
  const document = context.indexedDocument;
  for (let index = 0; index < iterations; index += 1) {
    document.score = index % 2 === 0 ? 1 : 2;
    context.indexedCollection.update(document);
  }
}

function runUpdateTextFrequent(context: Context, iterations: number): void {
  const document = context.document;
  for (let index = 0; index < iterations; index += 1) {
    document.body = document.body === "common odd rare tail" ? "replacement odd rare tail" : "common odd rare tail";
    context.collection.update(document);
  }
}

function runUpdateTextIndexedFrequent(context: Context, iterations: number): void {
  const document = context.textDocument;
  for (let index = 0; index < iterations; index += 1) {
    document.body = document.body === "common odd rare tail" ? "replacement odd rare tail" : "common odd rare tail";
    context.textCollection.update(document);
  }
}

function runUpdateTextRare(context: Context, iterations: number): void {
  const document = context.rareDocument;
  for (let index = 0; index < iterations; index += 1) {
    document.body = document.body === "rarealpha" ? "rarebeta" : "rarealpha";
    context.rareCollection.update(document);
  }
}

function runUpdateTextIndexedRare(context: Context, iterations: number): void {
  const document = context.rareTextDocument;
  for (let index = 0; index < iterations; index += 1) {
    document.body = document.body === "rarealpha" ? "rarebeta" : "rarealpha";
    context.rareTextCollection.update(document);
  }
}

function runCountAll(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.collection.count();
  }
}

function runCount(context: Context, iterations: number): void {
  const query = { group: 5 };
  for (let index = 0; index < iterations; index += 1) {
    context.collection.count(query);
  }
}

function runCountIndexed(context: Context, iterations: number): void {
  const query = { group: 5 };
  for (let index = 0; index < iterations; index += 1) {
    context.indexedCollection.count(query);
  }
}

function runAdd(context: Context, iterations: number): void {
  const data = context.database.data.collections.records.data;
  const baselineLength = data.length;
  for (let index = 0; index < iterations; index += 1) {
    context.collection.add({ group: 20 });
    if (data.length === baselineLength + 1_024) {
      data.length = baselineLength;
    }
  }
  data.length = baselineLength;
}

function runRemove(context: Context, iterations: number): void {
  const data = context.database.data.collections.records.data;
  const marker = { $id: -1 };
  for (let index = 0; index < iterations; index += 1) {
    data.push(marker);
    context.collection.remove(marker);
  }
}

function runAddRemove(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    const added = context.collection.add({ group: 20 })!;
    context.collection.remove(added);
  }
}

function runAddRemoveIndexed(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    const added = context.indexedCollection.add({
      group: 20,
      score: -1,
      active: false
    })!;
    context.indexedCollection.remove(added);
  }
}

function runReindexSmall(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.reindexSmallCollection.reindex();
  }
}

function runReindexLarge(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.reindexLargeCollection.reindex();
  }
}

function runRecreateExactIndex(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.reindexLargeCollection.dropIndex("by-group");
    context.reindexLargeCollection.createIndex("by-group", "group");
  }
}

function runRecreateTextIndex(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.textCollection.dropTextIndex("body");
    context.textCollection.createTextIndex("body", "body");
  }
}

function runUse(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.database.use(noopPlugin);
    context.collection.use(noopPlugin);
  }
}

function runUseStatic(context: Context, iterations: number): void {
  for (let index = 0; index < iterations; index += 1) {
    context.IluDb.use(noopPlugin);
  }
}

const benchmarks: Benchmark[] = [
  { name: "database", run: runDatabase },
  {
    name: "database/getCollection-new",
    run: runCreateDatabaseAndCollection
  },
  { name: "getCollection-existing", run: runGetCollection },
  { name: "getCollection-static", run: runGetCollectionStatic },
  { name: "sort", run: runSort },
  { name: "find/scan-50-percent", run: runFind },
  { name: "find/index-50-percent", run: runFindIndexedHalf },
  { name: "find/scan-10-percent", run: runFindTenth },
  { name: "find/index-10-percent", run: runFindIndexedTenth },
  { name: "find/scan-0.1-percent", run: runFindRare },
  { name: "find/index-0.1-percent", run: runFindIndexedRare },
  {
    name: "searchText/AND-high-50-percent",
    run: runSearchTextAndHigh,
    supported: supportsTextIndexes
  },
  {
    name: "searchText/AND-low-0.1-percent",
    run: runSearchTextAndLow,
    supported: supportsTextIndexes
  },
  {
    name: "searchText/OR-high-100-percent",
    run: runSearchTextOrHigh,
    supported: supportsTextIndexes
  },
  {
    name: "searchText/OR-low-0.2-percent",
    run: runSearchTextOrLow,
    supported: supportsTextIndexes
  },
  { name: "find/sort", run: runFindSorted },
  { name: "findOne", run: runFindOne },
  { name: "findOne/index-sort-10-percent", run: runFindOneSorted },
  { name: "get", run: runGet },
  { name: "update/no-index", run: runUpdate },
  { name: "update/three-indexes", run: runUpdateIndexed },
  {
    name: "update-text/frequent-no-index",
    run: runUpdateTextFrequent
  },
  {
    name: "update-text/frequent-indexed",
    run: runUpdateTextIndexedFrequent,
    supported: supportsTextIndexes
  },
  { name: "update-text/rare-no-index", run: runUpdateTextRare },
  {
    name: "update-text/rare-indexed",
    run: runUpdateTextIndexedRare,
    supported: supportsTextIndexes
  },
  { name: "count", run: runCount },
  { name: "count/index-10-percent", run: runCountIndexed },
  { name: "count/all", run: runCountAll },
  { name: "add", run: runAdd },
  { name: "remove", run: runRemove },
  { name: "add/remove-no-index", run: runAddRemove },
  { name: "add/remove-three-indexes", run: runAddRemoveIndexed },
  {
    name: "reindex/100-documents-one-index",
    run: runReindexSmall,
    supported: supportsReindex
  },
  {
    name: "reindex/1000-documents-one-index",
    run: runReindexLarge,
    supported: supportsReindex
  },
  {
    name: "index/recreate-exact-1000-documents",
    run: runRecreateExactIndex
  },
  {
    name: "index/recreate-text-1000-documents",
    run: runRecreateTextIndex,
    supported: supportsTextIndexes
  },
  { name: "use/duplicate", run: runUse },
  { name: "use/static-duplicate", run: runUseStatic }
];

function median(samples: number[]): number {
  const sorted = samples.slice();
  sorted.sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function measureBundle(bundle: string, baseline: Map<string, number> | null): Map<string, number> {
  const IluDb = require(bundle) as IluDbStatic;
  for (let index = 0; index < WARM_UP_ITERATIONS; index += 1) {
    const context = createContext(IluDb);
    for (let benchmarkIndex = 0; benchmarkIndex < benchmarks.length; benchmarkIndex += 1) {
      const benchmark = benchmarks[benchmarkIndex];
      if (typeof benchmark.supported === "undefined" || benchmark.supported(context)) {
        benchmark.run(context, 1);
      }
    }
  }

  console.log(
    `bundle=${bundle} dataset=${DATASET_SIZE} warmUp=${WARM_UP_ITERATIONS} samples=${SAMPLE_COUNT} targetMs=${TARGET_MS}`
  );
  console.log("textFrequencies=common:1000 even:500 odd:500 rare:1 scarce:1 tail:1");
  const results = new Map<string, number>();

  for (let benchmarkIndex = 0; benchmarkIndex < benchmarks.length; benchmarkIndex += 1) {
    const benchmark = benchmarks[benchmarkIndex];
    const context = createContext(IluDb);
    if (typeof benchmark.supported !== "undefined" && !benchmark.supported(context)) {
      console.log(`${benchmark.name}: unsupported by this bundle`);
      continue;
    }
    let iterations = 100;
    let elapsedMs: number;

    do {
      const startedAt = performance.now();
      benchmark.run(context, iterations);
      elapsedMs = performance.now() - startedAt;
      if (elapsedMs < CALIBRATION_MIN_MS) {
        iterations *= 2;
      }
    } while (elapsedMs < CALIBRATION_MIN_MS);

    iterations = Math.max(1, Math.ceil((iterations * (TARGET_MS / SAMPLE_COUNT)) / elapsedMs));
    const samples = new Array<number>(SAMPLE_COUNT);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = 0;
    let totalElapsedMs = 0;
    for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
      const startedAt = performance.now();
      benchmark.run(context, iterations);
      elapsedMs = performance.now() - startedAt;
      totalElapsedMs += elapsedMs;
      const operationsPerSecond = (iterations / elapsedMs) * 1_000;
      samples[sampleIndex] = operationsPerSecond;
      if (operationsPerSecond < minimum) {
        minimum = operationsPerSecond;
      }
      if (operationsPerSecond > maximum) {
        maximum = operationsPerSecond;
      }
    }
    const medianOperationsPerSecond = median(samples);
    results.set(benchmark.name, medianOperationsPerSecond);
    const baselineMedian = baseline?.get(benchmark.name);
    const comparison =
      typeof baselineMedian === "undefined"
        ? ""
        : `, ${(medianOperationsPerSecond / baselineMedian).toFixed(2)}x baseline`;

    console.log(
      `${benchmark.name}: median=${medianOperationsPerSecond.toFixed(2)} ops/s, ` +
        `range=${minimum.toFixed(2)}-${maximum.toFixed(2)}, ` +
        `measured=${totalElapsedMs.toFixed(2)} ms ` +
        `(${SAMPLE_COUNT} samples x ${iterations} iterations${comparison})`
    );
  }
  return results;
}

const baselineResults = baselineBundle === null ? null : measureBundle(baselineBundle, null);
measureBundle(currentBundle, baselineResults);

const temporaryRoot = resolve("tmp");
mkdirSync(temporaryRoot, { recursive: true });
const jsonWorkspace = mkdtempSync(join(temporaryRoot, "iludb-json-bench-"));
const JSONIluDb = require(currentBundle) as IluDbStatic;
const persistenceFixtures = [100, 1_000].map((size) => {
  const memoryDatabase = JSONIluDb();
  const records = memoryDatabase.getCollection("records");
  for (let index = 0; index < size; index += 1) {
    records.add({
      group: index % 10,
      body: index % 2 === 0 ? "common even" : "common odd"
    });
  }
  return {
    file: join(jsonWorkspace, `database-${size}.json`),
    serialized: JSON.stringify({ ...memoryDatabase.data, revision: 0 }),
    size
  };
});
JSONIluDb.use(nodeJSONPlugin);
for (let index = 0; index < persistenceFixtures.length; index += 1) {
  const fixture = persistenceFixtures[index];
  await Bun.write(fixture.file, fixture.serialized);
  const jsonDatabase = JSONIluDb(fixture.file) as Database & {
    reload(): void;
  };
  const records = jsonDatabase.getCollection("records");
  records.createIndex("by-group", "group");
  records.createTextIndex("content", "body");
  const saveSamples = new Array<number>(SAMPLE_COUNT);
  const reloadSamples = new Array<number>(SAMPLE_COUNT);
  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    const saveStartedAt = performance.now();
    jsonDatabase.save();
    saveSamples[sampleIndex] = performance.now() - saveStartedAt;
    const reloadStartedAt = performance.now();
    jsonDatabase.reload();
    reloadSamples[sampleIndex] = performance.now() - reloadStartedAt;
  }
  console.log(
    `json/save-atomic-${fixture.size}-documents: median=${median(saveSamples).toFixed(2)} ms, ` +
      `range=${Math.min(...saveSamples).toFixed(2)}-${Math.max(...saveSamples).toFixed(2)} ` +
      `(${SAMPLE_COUNT} samples)`
  );
  console.log(
    `json/reload-${fixture.size}-documents-two-indexes: median=${median(reloadSamples).toFixed(2)} ms, ` +
      `range=${Math.min(...reloadSamples).toFixed(2)}-${Math.max(...reloadSamples).toFixed(2)} ` +
      `(${SAMPLE_COUNT} samples)`
  );
}
