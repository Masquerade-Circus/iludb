import { beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = resolve(root, "tmp");
mkdirSync(temporaryRoot, { recursive: true });
const workspace = mkdtempSync(join(temporaryRoot, "iludb-entrypoints-"));
const archive = join(workspace, "iludb.tgz");
const extraction = join(workspace, "extracted");
const packedPackage = join(extraction, "package");
const installedPackage = join(workspace, "node_modules", "iludb");
const distributions = ["iludb.js", "iludb.min.js"];
const pluginDistributions = ["node-json.js", "node-json.min.js"];

function waitFor(check: () => boolean, timeout = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = (): void => {
      if (check()) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        rejectPromise(new Error("Timed out while waiting for file watch."));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function openNodeDatabase(file: string): any {
  const IluDB = require(join(root, "dist/iludb.js"));
  const database = IluDB({ adapter: require(join(root, "dist/plugins/node-json.js")) });
  database.load(file);
  return database;
}

function run({ command, cwd = root }: { command: string[]; cwd?: string }): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}${result.stdout.toString()}`);
  }
}

beforeAll(() => {
  mkdirSync(extraction);
  run({
    command: ["bun", "pm", "pack", "--filename", archive, "--ignore-scripts"]
  });
  run({ command: ["tar", "-xzf", archive, "-C", extraction] });
  mkdirSync(dirname(installedPackage), { recursive: true });
  cpSync(packedPackage, installedPackage, { recursive: true });
});

// These cases use the approved per-instance adapter API. The older cases below
// remain available to the implementer for migration without losing regressions.
for (const runtime of ["node", "bun"]) {
  for (const mode of ["sync", "async"]) {
    describe(`Unified persistence ${runtime} ${mode}`, () => {
      const asynchronous = mode === "async";

      function createDatabase(): any {
        const consumer = createRequire(join(workspace, "unified-consumer.cjs"));
        const IluDB = consumer("iludb");
        const adapter = consumer(`iludb/plugins/${runtime}-json`);
        return IluDB({ adapter: adapter.default ?? adapter });
      }

      // Invoke the actual selected public method, including its synchronous
      // throw path. This helper does not replace storage or production logic.
      async function invoke({
        database,
        operation,
        args = []
      }: {
        database: any;
        operation: string;
        args?: any[];
      }): Promise<any> {
        const method = asynchronous ? `async${operation[0].toUpperCase()}${operation.slice(1)}` : operation;
        return database[method](...args);
      }

      function collection(database: any): any {
        return asynchronous ? database.getAsyncCollection("records") : database.getCollection("records");
      }

      it("recovers from an invalid first load and refuses retargeting after success", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-load.json`);
        writeFileSync(file, "not JSON");
        try {
          await expect(invoke({ database, operation: "load", args: [file] })).rejects.toThrow();
          expect(readFileSync(file, "utf8")).toBe("not JSON");
          const validFile = join(workspace, `${runtime}-${mode}-load-recovered.json`);
          await invoke({ database, operation: "load", args: [validFile] });
          const records = collection(database);
          await records.add({ value: "retained" });
          const bytes = readFileSync(validFile, "utf8");
          await expect(invoke({ database, operation: "load", args: [file] })).rejects.toThrow();
          expect(await records.count({ value: "retained" })).toBe(1);
          expect(readFileSync(validFile, "utf8")).toBe(bytes);
          expect(readFileSync(file, "utf8")).toBe("not JSON");
        } finally {
          await invoke({ database, operation: "close" });
        }
      });

      it("rejects invalid mutations without publishing memory or disk and remains usable", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-reject.json`);
        await invoke({ database, operation: "load", args: [file] });
        try {
          const records = collection(database);
          const saved = await records.add({ value: "retained", body: "retained token" });
          await records.createIndex("by-value", "value");
          await records.createTextIndex("content", "body");
          const bytes = readFileSync(file, "utf8");
          const revision = (await invoke({ database, operation: "snapshot" })).revision;
          for (const invalid of [null, [], 42, { $id: 1 }, { invalidJSON: 1n }]) {
            await expect((async () => records.add(invalid))()).rejects.toThrow();
            expect(await records.count()).toBe(1);
            expect(readFileSync(file, "utf8")).toBe(bytes);
            expect((await invoke({ database, operation: "snapshot" })).revision).toBe(revision);
          }
          for (const operation of ["update", "remove"]) {
            await expect((async () => records[operation]({ $id: saved.$id + 100 }))()).rejects.toThrow();
            expect(readFileSync(file, "utf8")).toBe(bytes);
          }
          expect((await records.searchText("content", "retained"))[0].$id).toBe(saved.$id);
          await records.update({ $id: saved.$id, value: "recovered" });
          expect((await records.findOne({ value: "recovered" })).$id).toBe(saved.$id);
        } finally {
          await invoke({ database, operation: "close" });
        }
      });

      it("initializes collection plugins once and permits operations on their target", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-plugins.json`);
        await invoke({ database, operation: "load", args: [file] });
        try {
          const records = collection(database);
          const inspect = (target: any): void => {
            target.initialCount = target.count();
            target.total = () => target.count();
          };
          await records.use(inspect);
          expect(await records.initialCount).toBe(0);
          const initialize = (target: any): void => {
            void target.add({ value: "initialized" });
          };
          await records.use(initialize);
          await records.use(initialize);
          expect(await records.total()).toBe(1);
          const reopened = createDatabase();
          await invoke({ database: reopened, operation: "load", args: [file] });
          try {
            expect(await collection(reopened).count({ value: "initialized" })).toBe(1);
          } finally {
            await invoke({ database: reopened, operation: "close" });
          }
          await invoke({
            database,
            operation: "transaction",
            args: [
              (tx: any) => {
                const staged = tx.getCollection("records");
                staged.use(initialize);
                staged.use(initialize);
                expect(staged.count({ value: "initialized" })).toBe(2);
              }
            ]
          });
          expect(await records.total()).toBe(2);
        } finally {
          await invoke({ database, operation: "close" });
        }
      });

      it("rolls back throwing and thenable transactions and invalidates escaped handles", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-transaction.json`);
        await invoke({ database, operation: "load", args: [file] });
        try {
          const records = collection(database);
          const saved = await records.add({ value: "retained" });
          const external = database.getCollection("records");
          const bytes = readFileSync(file, "utf8");
          for (const completion of ["throw", "promise", "thenable", "reenter", "plugin-reenter"]) {
            await expect(
              invoke({
                database,
                operation: "transaction",
                args: [
                  (tx: any) => {
                    tx.getCollection("records").update({ $id: saved.$id, value: "uncommitted" });
                    expect(readFileSync(file, "utf8")).toBe(bytes);
                    if (completion === "throw") {
                      throw new Error("synthetic callback failure");
                    }
                    if (completion === "promise") {
                      return Promise.resolve("invalid callback result");
                    }
                    if (completion === "reenter") {
                      database.getCollection("records").add({ value: "external reentry" });
                      return;
                    }
                    if (completion === "plugin-reenter") {
                      external.use((target: any) => target.add({ value: "external plugin" }));
                      return;
                    }
                    return { then(): void {} };
                  }
                ]
              })
            ).rejects.toThrow();
            expect((await records.get(saved.$id)).value).toBe("retained");
            expect(await records.count()).toBe(1);
            expect(readFileSync(file, "utf8")).toBe(bytes);
          }
          let escaped: any = null;
          const result = await invoke({
            database,
            operation: "transaction",
            args: [
              (tx: any) => {
                escaped = tx.getCollection("records");
                escaped.update({ $id: saved.$id, value: "committed" });
                return escaped.add({ value: "second", nested: { retained: true } });
              }
            ]
          });
          expect(() => escaped.add({ value: "expired" })).toThrow();
          result.nested.retained = false;
          expect((await records.get(result.$id)).nested.retained).toBe(true);
          expect((await records.get(saved.$id)).value).toBe("committed");
          expect(JSON.parse(readFileSync(file, "utf8")).collections.records.data).toHaveLength(2);
        } finally {
          await invoke({ database, operation: "close" });
        }
      });

      it("preserves indexed queries across failed reloads and publishes valid replacements", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-reload.json`);
        await invoke({ database, operation: "load", args: [file] });
        try {
          const records = collection(database);
          const saved = await records.add({ value: "retained", body: "retained token" });
          await records.createIndex("by-value", "value");
          await records.createTextIndex("content", "body");
          const bytes = readFileSync(file, "utf8");
          const valid = JSON.parse(bytes);
          const duplicate = structuredClone(valid);
          duplicate.collections.records.data.push(structuredClone(duplicate.collections.records.data[0]));
          const invalidDate = structuredClone(valid);
          invalidDate.collections.records.data[0].$createdAt = "invalid";
          for (const contents of [
            "not JSON",
            "[]",
            JSON.stringify({ ...valid, revision: -1 }),
            JSON.stringify(duplicate),
            JSON.stringify(invalidDate)
          ]) {
            writeFileSync(file, contents);
            await expect(invoke({ database, operation: "reload" })).rejects.toThrow();
            expect((await records.findOne({ value: "retained" })).$id).toBe(saved.$id);
            expect((await records.searchText("content", "retained"))[0].$id).toBe(saved.$id);
            expect((await invoke({ database, operation: "snapshot" })).revision).toBe(valid.revision);
          }
          valid.revision += 1;
          valid.collections.records.data[0].value = "external";
          valid.collections.records.data[0].body = "external token";
          const replacement = `${file}.replacement`;
          writeFileSync(replacement, JSON.stringify(valid));
          renameSync(replacement, file);
          await invoke({ database, operation: "reload" });
          expect(await records.findOne({ value: "retained" })).toBeNull();
          expect((await records.findOne({ value: "external" })).$id).toBe(saved.$id);
          expect((await records.searchText("content", "external"))[0].$id).toBe(saved.$id);
          expect(await records.searchText("content", "retained")).toEqual([]);
        } finally {
          await invoke({ database, operation: "close" });
        }
      });

      it("rejects stale mutations without changing either snapshot and recovers by explicit reload", async () => {
        const writer = createDatabase();
        const stale = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-conflict.json`);
        await invoke({ database: writer, operation: "load", args: [file] });
        await invoke({ database: stale, operation: "load", args: [file] });
        try {
          await collection(writer).add({ value: "newer" });
          const bytes = readFileSync(file, "utf8");
          const before = await invoke({ database: stale, operation: "snapshot" });
          await expect((async () => collection(stale).add({ value: "stale" }))()).rejects.toThrow();
          expect(readFileSync(file, "utf8")).toBe(bytes);
          expect(await collection(stale).count()).toBe(0);
          expect((await invoke({ database: stale, operation: "snapshot" })).revision).toBe(before.revision);
          await invoke({ database: stale, operation: "reload" });
          await collection(stale).add({ value: "recovered" });
          expect(await collection(stale).count()).toBe(2);
        } finally {
          await invoke({ database: writer, operation: "close" });
          await invoke({ database: stale, operation: "close" });
        }
      });

      it("rejects linked and nonregular load destinations without altering their targets", async () => {
        const target = join(workspace, `${runtime}-${mode}-canary.json`);
        writeFileSync(target, "synthetic canary");
        const link = `${target}.link`;
        symlinkSync(target, link);
        for (const destination of [link, workspace]) {
          const database = createDatabase();
          try {
            await expect(invoke({ database, operation: "load", args: [destination] })).rejects.toThrow();
            expect(readFileSync(target, "utf8")).toBe("synthetic canary");
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
          } finally {
            await invoke({ database, operation: "close" });
          }
        }
      });

      it("rolls back denied writes and recovers after access is restored", async () => {
        const directory = join(workspace, `${runtime}-${mode}-denied`);
        mkdirSync(directory, { mode: 0o700 });
        const file = join(directory, "snapshot.json");
        const database = createDatabase();
        await invoke({ database, operation: "load", args: [file] });
        try {
          const records = collection(database);
          const saved = await records.add({ value: "retained" });
          await records.createIndex("by-value", "value");
          const bytes = readFileSync(file, "utf8");
          const revision = (await invoke({ database, operation: "snapshot" })).revision;
          chmodSync(directory, 0o500);
          await expect((async () => records.update({ $id: saved.$id, value: "unpublished" }))()).rejects.toThrow();
          expect(readFileSync(file, "utf8")).toBe(bytes);
          expect((await records.findOne({ value: "retained" })).$id).toBe(saved.$id);
          expect((await invoke({ database, operation: "snapshot" })).revision).toBe(revision);
          chmodSync(directory, 0o700);
          await records.update({ $id: saved.$id, value: "recovered" });
          expect((await records.findOne({ value: "recovered" })).$id).toBe(saved.$id);
        } finally {
          chmodSync(directory, 0o700);
          await invoke({ database, operation: "close" });
        }
      });

      it("watches valid replacements and retains indexes after invalid or missing files", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-watch.json`);
        await invoke({ database, operation: "load", args: [file] });
        try {
          const records = collection(database);
          await records.add({ value: "retained", body: "retained token" });
          await records.createIndex("by-value", "value");
          await records.createTextIndex("content", "body");
          let reloads = 0;
          database.watch({
            interval: 20,
            onReload(): void {
              reloads += 1;
            }
          });
          await invoke({ database, operation: "save" });
          await Bun.sleep(100);
          expect(reloads).toBe(0);
          const valid = JSON.parse(readFileSync(file, "utf8"));
          writeFileSync(file, "not JSON");
          await Bun.sleep(100);
          expect(await records.count({ value: "retained" })).toBe(1);
          renameSync(file, `${file}.missing`);
          await Bun.sleep(100);
          expect(await records.searchText("content", "retained")).toHaveLength(1);
          valid.revision += 1;
          valid.collections.records.data[0].value = "external";
          valid.collections.records.data[0].body = "external token";
          writeFileSync(file, JSON.stringify(valid));
          await waitFor(() => reloads > 0);
          expect(await records.count({ value: "external" })).toBe(1);
          expect(await records.searchText("content", "external")).toHaveLength(1);
          database.unwatch();
          database.unwatch();
          valid.revision += 1;
          valid.collections.records.data[0].value = "after cancellation";
          writeFileSync(file, JSON.stringify(valid));
          await Bun.sleep(100);
          expect(await records.count({ value: "external" })).toBe(1);
        } finally {
          database.unwatch();
          await invoke({ database, operation: "close" });
        }
      });

      it("loads legacy revision zero and exchanges snapshots with the other filesystem adapter", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-exchange.json`);
        await invoke({ database, operation: "load", args: [file] });
        const saved = await collection(database).add({ value: "portable" });
        await invoke({ database, operation: "close" });
        const legacy = JSON.parse(readFileSync(file, "utf8"));
        delete legacy.revision;
        writeFileSync(file, JSON.stringify(legacy));
        const consumer = createRequire(join(workspace, "exchange-consumer.cjs"));
        const adapter = consumer(`iludb/plugins/${runtime === "node" ? "bun" : "node"}-json`);
        const restored = consumer("iludb")({ adapter: adapter.default ?? adapter });
        try {
          await invoke({ database: restored, operation: "load", args: [file] });
          expect((await invoke({ database: restored, operation: "snapshot" })).revision).toBe(0);
          expect((await collection(restored).get(saved.$id)).$createdAt.getTime()).toBe(saved.$createdAt.getTime());
          await invoke({ database: restored, operation: "save" });
          expect(JSON.parse(readFileSync(file, "utf8")).revision).toBe(1);
        } finally {
          await invoke({ database: restored, operation: "close" });
        }
      });

      if (asynchronous) {
        it("queues admitted mutations rejects synchronous interleaving and drains on close", async () => {
          const database = createDatabase();
          const file = join(workspace, `${runtime}-mixed-queue.json`);
          database.load(file);
          const syncRecords = database.getCollection("records");
          const asyncRecords = database.getAsyncCollection("records");
          const input = { value: "admitted", nested: { retained: true } };
          const first = asyncRecords.add(input);
          input.value = "changed after admission";
          input.nested.retained = false;
          expect(() => syncRecords.add({ value: "forbidden interleave" })).toThrow();
          expect(() => database.save()).toThrow();
          expect(() => database.reload()).toThrow();
          const second = asyncRecords.add({ value: "second" });
          const closing = database.asyncClose();
          await expect((async () => asyncRecords.add({ value: "too late" }))()).rejects.toThrow();
          await Promise.all([first, second, closing]);
          await database.asyncClose();
          expect(() => syncRecords.add({ value: "closed" })).toThrow();
          const restored = createDatabase();
          restored.load(file);
          try {
            const documents = restored.getCollection("records").find({}, { sort: { $id: 1 } });
            expect(documents.map((document: any) => document.value)).toEqual(["admitted", "second"]);
            expect(documents[0].nested.retained).toBe(true);
          } finally {
            restored.close();
          }
        });
      }

      it("persists isolated CRUD results with sorting text search and preserved file mode", async () => {
        const database = createDatabase();
        const file = join(workspace, `${runtime}-${mode}-crud.json`);
        await invoke({ database, operation: "load", args: [file] });
        try {
          expect(lstatSync(file).mode & 0o077).toBe(0);
          chmodSync(file, 0o640);
          const records = collection(database);
          await records.createIndex("by-state", "state");
          await records.createTextIndex("content", "body");
          const input = {
            state: "open",
            score: 2,
            body: "Café azul",
            nested: { retained: true },
            userDate: new Date(0)
          };
          const saved = await records.add(input);
          input.nested.retained = false;
          saved.nested.retained = false;
          await records.add({ state: "open", score: 1, body: "cafe verde" });
          expect(
            (await records.find({ state: "open" }, { sort: { score: 1 } })).map((record: any) => record.score)
          ).toEqual([1, 2]);
          expect((await records.searchText("content", "CAFE azul"))[0].$id).toBe(saved.$id);
          expect(await records.searchText("content", "caf")).toEqual([]);
          expect((await records.get(saved.$id)).nested.retained).toBe(true);
          const updated = await records.update({ $id: saved.$id, state: "done", body: "final token" });
          expect(updated.$createdAt.getTime()).toBe(saved.$createdAt.getTime());
          expect(await records.count({ state: "open" })).toBe(1);
          expect(await records.searchText("content", "azul")).toEqual([]);
          const snapshot = await invoke({ database, operation: "snapshot" });
          snapshot.collections.records.data[0].state = "external mutation";
          expect((await records.get(saved.$id)).state).toBe("done");
          const restored = createDatabase();
          await invoke({ database: restored, operation: "load", args: [file] });
          try {
            const document = await collection(restored).get(saved.$id);
            expect(document.state).toBe("done");
            expect(document.userDate).toBe(new Date(0).toISOString());
            expect(document.$createdAt.getTime()).toBe(saved.$createdAt.getTime());
          } finally {
            await invoke({ database: restored, operation: "close" });
          }
          await records.remove(updated);
          expect(await records.get(saved.$id)).toBeNull();
          expect(await records.findOne({ state: "done" })).toBeNull();
          expect(await records.searchText("content", "final")).toEqual([]);
          expect(lstatSync(file).mode & 0o777).toBe(0o640);
        } finally {
          await invoke({ database, operation: "close" });
        }
      });
    });
  }
}

describe("Bun JSON public persistence", () => {
  function openConsumer() {
    const consumer = createRequire(join(workspace, "bun-consumer.cjs"));
    const IluDB = consumer("iludb");
    return IluDB;
  }

  async function openBunDatabase(file: string): Promise<any> {
    const consumer = createRequire(join(workspace, "bun-consumer.cjs"));
    const database = consumer("iludb")({ adapter: consumer("iludb/plugins/bun-json") });
    await database.asyncLoad(file);
    return database;
  }

  it("rejects invalid or linked snapshots without replacing their contents", async () => {
    for (const [index, contents] of ["not JSON", "[]", '{"revision":-1,"collections":{}}'].entries()) {
      const file = join(workspace, `bun-invalid-${index}.json`);
      writeFileSync(file, contents);
      await expect(openBunDatabase(file)).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
    const canary = join(workspace, "bun-link-canary.json");
    writeFileSync(canary, "synthetic canary");
    const link = join(workspace, "bun-link.json");
    symlinkSync(canary, link);
    await expect(openBunDatabase(link)).rejects.toThrow();
    expect(readFileSync(canary, "utf8")).toBe("synthetic canary");
  });

  it("rejects invalid additions without persisting or breaking later operations", async () => {
    const file = join(workspace, "bun-invalid-add.json");
    const database = await openBunDatabase(file);
    try {
      const records = database.getAsyncCollection("records");
      const original = readFileSync(file, "utf8");
      expect(await records.get(123)).toBeNull();
      expect(await records.findOne({ value: "absent" })).toBeNull();
      for (const document of [null, [], 42, { $id: 1, value: "reserved" }]) {
        await expect(records.add(document)).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(await records.count()).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(original);
      }
      const added = await records.add({ value: "valid" });
      expect((await records.get(added.$id)).value).toBe("valid");
    } finally {
      await database.asyncClose();
    }
  });

  it("discards throwing and asynchronous transactions without exposing a mutable active stage", async () => {
    const file = join(workspace, "bun-rollback.json");
    const database = await openBunDatabase(file);
    try {
      const records = database.getAsyncCollection("records");
      const before = readFileSync(file, "utf8");
      await expect(
        database.asyncTransaction((tx: any) => {
          tx.getCollection("records").add({ value: "must not publish" });
          expect(readFileSync(file, "utf8")).toBe(before);
          throw new Error("synthetic transaction failure");
        })
      ).rejects.toThrow();
      await expect(
        database.asyncTransaction((tx: any) => {
          tx.getCollection("records").add({ value: "must not publish" });
          return Promise.resolve("invalid async callback");
        })
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await records.count()).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(before);
      let leaked: any = null;
      const returned = await database.asyncTransaction((tx: any) => {
        leaked = tx.getCollection("records");
        return leaked.add({ value: "committed" });
      });
      expect(() => leaked.add({ value: "outside callback" })).toThrow();
      returned.value = "external mutation";
      expect((await records.get(returned.$id)).value).toBe("committed");
    } finally {
      await database.asyncClose();
    }
  });

  it("preserves committed data and indexed queries when reload validation fails", async () => {
    const file = join(workspace, "bun-reload.json");
    const database = await openBunDatabase(file);
    try {
      const records = database.getAsyncCollection("records");
      await records.createIndex("by-state", "state");
      const saved = await records.add({ state: "retained" });
      const bytes = readFileSync(file, "utf8");
      const revision = (await database.asyncSnapshot()).revision;
      writeFileSync(file, "not JSON");
      await expect(database.asyncReload()).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
      expect((await records.findOne({ state: "retained" })).$id).toBe(saved.$id);
      expect((await database.asyncSnapshot()).revision).toBe(revision);
      writeFileSync(file, bytes);
      await database.asyncReload();
      expect((await records.findOne({ state: "retained" })).$id).toBe(saved.$id);
    } finally {
      await database.asyncClose();
    }
  });

  it("rejects an unserializable staged document without publishing it or changing the committed file", async () => {
    const file = join(workspace, "bun-serialization-rollback.json");
    const database = await openBunDatabase(file);
    try {
      const records = database.getAsyncCollection("records");
      const initial = await records.add({ value: "retained" });
      const bytes = readFileSync(file, "utf8");
      const revision = (await database.asyncSnapshot()).revision;
      await expect(
        database.asyncTransaction((tx: any) => {
          tx.getCollection("records").update({ $id: initial.$id, value: "must not publish", invalidJSON: 1n });
        })
      ).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect((await database.asyncSnapshot()).revision).toBe(revision);
      expect((await records.get(initial.$id)).value).toBe("retained");
      await records.update({ $id: initial.$id, value: "later valid update" });
      expect((await records.get(initial.$id)).value).toBe("later valid update");
    } finally {
      await database.asyncClose();
    }
  });

  it("rejects a stale checkpoint without retry or replacing the newer snapshot", async () => {
    const file = join(workspace, "bun-stale.json");
    const writer = await openBunDatabase(file);
    const stale = await openBunDatabase(file);
    try {
      await writer.getAsyncCollection("records").add({ value: "newer" });
      const before = readFileSync(file, "utf8");
      const currentRevision = (await writer.asyncSnapshot()).revision;
      await expect(stale.asyncSave()).rejects.toMatchObject({
        code: "CONFLICT",
        expectedRevision: 0,
        actualRevision: currentRevision
      });
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(await stale.getAsyncCollection("records").count()).toBe(0);
    } finally {
      await writer.asyncClose();
      await stale.asyncClose();
    }
  });

  it("captures admitted arguments and isolates documents while persisting before resolution", async () => {
    const file = join(workspace, "bun-isolation.json");
    const database = await openBunDatabase(file);
    try {
      const records = database.getAsyncCollection("records");
      const document = { value: "admitted", nested: { retained: true } };
      const pending = records.add(document);
      document.value = "changed after admission";
      document.nested.retained = false;
      const saved = await pending;
      saved.nested.retained = false;
      const independent = await openBunDatabase(file);
      try {
        const restored = await independent.getAsyncCollection("records").get(saved.$id);
        expect(restored.value).toBe("admitted");
        expect(restored.nested.retained).toBe(true);
        expect(restored.$createdAt).toBeInstanceOf(Date);
      } finally {
        await independent.asyncClose();
      }
      const snapshot = await database.asyncSnapshot();
      snapshot.collections.records.data[0].value = "changed snapshot";
      expect((await records.get(saved.$id)).value).toBe("admitted");
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
    } finally {
      await database.asyncClose();
    }
  });

  it("rolls back a real denied temporary write without changing committed data or indexes", async () => {
    const directory = join(workspace, "bun-write-denied");
    mkdirSync(directory, { mode: 0o700 });
    const file = join(directory, "snapshot.json");
    const database = await openBunDatabase(file);
    try {
      const records = database.getAsyncCollection("records");
      await records.createIndex("by-value", "value");
      const saved = await records.add({ value: "retained" });
      const bytes = readFileSync(file, "utf8");
      const revision = (await database.asyncSnapshot()).revision;
      chmodSync(directory, 0o500);
      await expect(records.update({ $id: saved.$id, value: "not published" })).rejects.toMatchObject({ code: "IO" });
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect((await records.findOne({ value: "retained" })).$id).toBe(saved.$id);
      expect((await database.asyncSnapshot()).revision).toBe(revision);
      chmodSync(directory, 0o700);
      await records.update({ $id: saved.$id, value: "later valid" });
      expect((await records.findOne({ value: "later valid" })).$id).toBe(saved.$id);
    } finally {
      chmodSync(directory, 0o700);
      await database.asyncClose();
    }
  });

  it("drains admitted mutations on close and rejects new operations without an implicit save", async () => {
    const file = join(workspace, "bun-close.json");
    const database = await openBunDatabase(file);
    const records = database.getAsyncCollection("records");
    const first = records.add({ value: "first" });
    const second = records.add({ value: "second" });
    const closing = database.asyncClose();
    await expect(records.add({ value: "late" })).rejects.toMatchObject({ code: "CLOSED" });
    await expect(records.add({ value: () => "invalid and late" })).rejects.toMatchObject({ code: "CLOSED" });
    await Promise.all([first, second, closing]);
    await database.asyncClose();
    const restored = await openBunDatabase(file);
    try {
      expect(
        (await restored.getAsyncCollection("records").find({}, { sort: { $id: 1 } })).map((record: any) => record.value)
      ).toEqual(["first", "second"]);
      expect((await restored.asyncSnapshot()).revision).toBe(2);
    } finally {
      await restored.asyncClose();
    }
  });

  it("coexists with synchronous memory and node-json consumers without replacing their API", async () => {
    const IluDB = openConsumer();
    const memory = IluDB();
    const local = memory.getCollection("records").add({ value: "synchronous memory" });
    expect(local instanceof Promise).toBe(false);
    expect(memory.getCollection("records").get(local.$id).value).toBe("synchronous memory");
    const consumer = createRequire(join(workspace, "bun-consumer.cjs"));
    const file = join(workspace, "coexisting-node.json");
    const synchronous = IluDB({ adapter: consumer("iludb/plugins/node-json") });
    synchronous.load(file);
    const saved = synchronous.getCollection("records").add({ value: "synchronous disk" });
    expect(saved instanceof Promise).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).collections.records.data[0].value).toBe("synchronous disk");
    const asynchronous = await openBunDatabase(join(workspace, "coexisting-bun.json"));
    try {
      const added = await asynchronous.getAsyncCollection("records").add({ value: "async disk" });
      expect((await asynchronous.getAsyncCollection("records").get(added.$id)).value).toBe("async disk");
      expect(synchronous.getCollection("records").get(saved.$id).value).toBe("synchronous disk");
    } finally {
      await asynchronous.asyncClose();
      synchronous.close();
    }
  });
});

describe("Public entrypoints", () => {
  it("reloads transactionally and keeps collection bindings stable", () => {
    const databaseFile = join(workspace, "reload-bindings.json");
    const database = openNodeDatabase(databaseFile);
    const first = database.getCollection("records");
    const second = database.getCollection("records");
    first.createIndex("by-state", "state");
    first.createTextIndex("content", "body");
    first.add({ state: "local", body: "local token" });
    const stableSnapshot = JSON.parse(readFileSync(databaseFile, "utf8"));
    const revision = database.snapshot().revision;

    const invalidSnapshots = [
      { label: "root", value: [] },
      {
        label: "collections",
        value: { ...stableSnapshot, collections: [] }
      },
      {
        label: "collection",
        value: {
          ...stableSnapshot,
          collections: { records: [] }
        }
      },
      {
        label: "data",
        value: {
          ...stableSnapshot,
          collections: {
            records: {
              ...stableSnapshot.collections.records,
              data: {}
            }
          }
        }
      },
      {
        label: "index",
        value: {
          ...stableSnapshot,
          collections: {
            records: {
              ...stableSnapshot.collections.records,
              index: -1
            }
          }
        }
      },
      {
        label: "document",
        value: {
          ...stableSnapshot,
          collections: {
            records: {
              ...stableSnapshot.collections.records,
              data: [[]]
            }
          }
        }
      },
      {
        label: "revision",
        value: { ...stableSnapshot, revision: -1 }
      },
      {
        label: "missing document id",
        value: (() => {
          const value = structuredClone(stableSnapshot);
          delete value.collections.records.data[0].$id;
          return value;
        })()
      },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((documentId) => {
        const value = structuredClone(stableSnapshot);
        value.collections.records.data[0].$id = documentId;
        return {
          label: `invalid document id ${String(documentId)}`,
          value
        };
      }),
      {
        label: "duplicate document id",
        value: (() => {
          const value = structuredClone(stableSnapshot);
          value.collections.records.data.push(structuredClone(value.collections.records.data[0]));
          return value;
        })()
      },
      {
        label: "collection index below maximum id",
        value: (() => {
          const value = structuredClone(stableSnapshot);
          value.collections.records.data[0].$id = 2;
          value.collections.records.index = 1;
          return value;
        })()
      }
    ];
    for (let index = 0; index < invalidSnapshots.length; index += 1) {
      const invalid = invalidSnapshots[index];
      writeFileSync(databaseFile, JSON.stringify(invalid.value));
      expect(() => database.reload(), invalid.label).toThrow();
      expect(database.snapshot().revision, invalid.label).toBe(revision);
      expect(second.find({ state: "local" }), invalid.label).toHaveLength(1);
      expect(second.searchText("content", "local"), invalid.label).toHaveLength(1);
    }

    const external = structuredClone(stableSnapshot);
    external.revision += 1;
    external.collections.records.data[0].state = "external";
    external.collections.records.data[0].body = "external token";
    const replacement = `${databaseFile}.replacement`;
    writeFileSync(replacement, JSON.stringify(external));
    renameSync(replacement, databaseFile);
    database.reload();
    expect(first.find({ state: "external" })).toHaveLength(1);
    expect(second.searchText("content", "external")).toHaveLength(1);

    const withoutRecords = { ...external, revision: external.revision + 1 };
    withoutRecords.collections = {};
    writeFileSync(replacement, JSON.stringify(withoutRecords));
    renameSync(replacement, databaseFile);
    database.reload();
    expect(() => first.find()).toThrow();
    expect(() => second.reindex()).toThrow();
    const recreated = database.getCollection("records");
    expect(recreated.find()).toEqual([]);
    recreated.createIndex("by-state", "state");
    recreated.createTextIndex("content", "body");
    recreated.add({ state: "recreated", body: "recreated token" });
    expect(first.find({ state: "recreated" })).toHaveLength(1);
    expect(first.searchText("content", "recreated")).toHaveLength(1);
    database.close();
  });

  it("persists revisions and rejects stale or disappeared snapshots", () => {
    const plugin = require(join(root, "dist/plugins/node-json.js"));
    const databaseFile = join(workspace, "revision-conflicts.json");
    const created = openNodeDatabase(databaseFile);
    expect(created.snapshot().revision).toBe(0);
    const legacy = JSON.parse(readFileSync(databaseFile, "utf8"));
    delete legacy.revision;
    writeFileSync(databaseFile, JSON.stringify(legacy));
    const first = openNodeDatabase(databaseFile);
    expect(first.snapshot().revision).toBe(0);
    first.save();
    expect(JSON.parse(readFileSync(databaseFile, "utf8")).revision).toBe(1);

    const stale = openNodeDatabase(databaseFile);
    first.save();
    const beforeConflict = stale.snapshot().revision;
    let conflict: any = null;
    try {
      stale.save();
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(plugin.ConflictError);
    expect(conflict.expectedRevision).toBe(1);
    expect(conflict.actualRevision).toBe(2);
    expect(stale.snapshot().revision).toBe(beforeConflict);
    expect(stale.getCollection("records").count()).toBe(0);

    const moved = `${databaseFile}.moved`;
    renameSync(databaseFile, moved);
    expect(() => first.save()).toThrow(plugin.ConflictError);
    try {
      first.save();
    } catch (error: any) {
      expect(error.actualRevision).toBeNull();
    }
  });

  it("rejects removed constructor paths without changing an existing snapshot", () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const file = join(workspace, "removed-constructor.json");
    writeFileSync(file, "synthetic canary");
    expect(() => IluDB(file)).toThrow();
    expect(() => IluDB.getDatabase(file)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("synthetic canary");
  });

  it("persists changes, preserves access permissions and rejects symbolic links", () => {
    const databaseFile = join(workspace, "atomic-save.json");
    const database = openNodeDatabase(databaseFile);
    chmodSync(databaseFile, 0o640);
    database.getCollection("records").add({ value: "published" });
    expect(lstatSync(databaseFile).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(databaseFile, "utf8")).collections.records.data[0].value).toBe("published");

    const target = join(workspace, "symlink-target.json");
    const link = join(workspace, "symlink-database.json");
    writeFileSync(target, readFileSync(databaseFile));
    symlinkSync(target, link);
    renameSync(databaseFile, `${databaseFile}.original`);
    symlinkSync(target, databaseFile);
    expect(() => database.save()).toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("persists a multi-buffer payload completely before returning", () => {
    const file = join(workspace, "complete-write.json");
    const database = openNodeDatabase(file);
    const payload = "synthetic payload ".repeat(10000);
    const saved = database.getCollection("records").add({ payload });
    const reopened = openNodeDatabase(file);
    expect(reopened.getCollection("records").get(saved.$id).payload).toBe(payload);
    reopened.close();
    database.close();
  });

  it("watches external replacements, contains callback errors and ignores own saves", async () => {
    const databaseFile = join(workspace, "watched.json");
    const database = openNodeDatabase(databaseFile);
    let reloads = 0;
    let errors = 0;
    database.watch({
      interval: 20,
      onReload(): void {
        reloads += 1;
        if (reloads === 1) {
          throw new Error("callback failure");
        }
      },
      onError(): void {
        errors += 1;
        throw new Error("contained error callback");
      }
    });
    database.getCollection("records").add({ value: "own" });
    await Bun.sleep(80);
    expect(reloads).toBe(0);

    const external = JSON.parse(readFileSync(databaseFile, "utf8"));
    external.revision += 1;
    external.external = true;
    const replacement = `${databaseFile}.replacement`;
    writeFileSync(replacement, JSON.stringify(external));
    renameSync(replacement, databaseFile);
    await waitFor(() => reloads === 1);
    expect(database.snapshot().external).toBe(true);
    expect(errors).toBe(1);
    database.unwatch();
    database.unwatch();
  });

  it("keeps watching through invalid, deleted and reappearing files without callbacks", async () => {
    const databaseFile = join(workspace, "watch-recovery.json");
    const database = openNodeDatabase(databaseFile);
    const originalRevision = database.snapshot().revision;
    expect(() => database.watch({ interval: 0 })).toThrow();
    expect(() => database.watch({ onReload: true })).toThrow();
    expect(() => database.watch({ onError: true })).toThrow();
    database.watch({ interval: 20 });
    database.watch({ interval: 0 });

    const replacement = `${databaseFile}.replacement`;
    writeFileSync(replacement, "{");
    renameSync(replacement, databaseFile);
    await Bun.sleep(80);
    expect(database.snapshot().revision).toBe(originalRevision);

    const valid = {
      ...JSON.parse(readFileSync(join(workspace, "watched.json"), "utf8")),
      recovered: 1
    };
    writeFileSync(replacement, JSON.stringify(valid));
    renameSync(replacement, databaseFile);
    await waitFor(() => {
      try {
        return database.snapshot().recovered === 1;
      } catch {
        return false;
      }
    });

    const missing = `${databaseFile}.missing`;
    renameSync(databaseFile, missing);
    await Bun.sleep(80);
    expect(database.snapshot().recovered).toBe(1);
    valid.revision += 1;
    valid.recovered = 2;
    writeFileSync(databaseFile, JSON.stringify(valid));
    await waitFor(() => {
      try {
        return database.snapshot().recovered === 2;
      } catch {
        return false;
      }
    });
    database.unwatch();
  });

  it("loads the latest external data after repeated replacements", async () => {
    const file = join(workspace, "watch-coalescing.json");
    const database = openNodeDatabase(file);
    database.getCollection("records").add({ value: "initial" });
    database.watch({ interval: 20 });
    try {
      const external = JSON.parse(readFileSync(file, "utf8"));
      for (let revision = 2; revision <= 4; revision += 1) {
        external.revision = revision;
        external.collections.records.data[0].value = `replacement-${revision}`;
        writeFileSync(`${file}.replacement`, JSON.stringify(external));
        renameSync(`${file}.replacement`, file);
      }
      await waitFor(() => {
        try {
          return database.snapshot().revision === 4;
        } catch {
          return false;
        }
      });
      expect(database.getCollection("records").findOne({ value: "replacement-4" })).not.toBeNull();
    } finally {
      await database.asyncClose();
    }
  });

  it("keeps readable and minified core bundles functionally equivalent", () => {
    for (let index = 0; index < distributions.length; index += 1) {
      run({
        command: [
          "node",
          "-e",
          `
const IluDB = require(${JSON.stringify(join(root, "dist", distributions[index]))});
const records = IluDB().getCollection("records");
records.add({ value: "expected" });
if (records.findOne({ value: "expected" }).value !== "expected") {
    throw new Error("core distribution changed behavior");
}
`
        ]
      });
    }
  });

  it("keeps readable and minified Node JSON plugins functionally equivalent", () => {
    for (let index = 0; index < pluginDistributions.length; index += 1) {
      const databaseFile = join(workspace, `database-${index}.json`);
      run({
        command: [
          "node",
          "-e",
          `
const fs = require("node:fs");
const IluDB = require(${JSON.stringify(join(root, "dist/iludb.js"))});
const plugin = require(${JSON.stringify(join(root, "dist/plugins", pluginDistributions[index]))});
const database = IluDB({ adapter: plugin });
database.load(${JSON.stringify(databaseFile)});
const records = database.getCollection("records");
const added = records.add({ name: "added" });
let serialized = fs.readFileSync(${JSON.stringify(databaseFile)}, "utf8");
if (!serialized.includes("added")) throw new Error("add returned before persistence");
records.update({ ...added, name: "updated" });
serialized = fs.readFileSync(${JSON.stringify(databaseFile)}, "utf8");
if (!serialized.includes("updated")) throw new Error("update returned before persistence");
records.remove(added);
if (fs.readFileSync(${JSON.stringify(databaseFile)}, "utf8").includes("updated")) {
    throw new Error("remove returned before persistence");
}
`
        ]
      });
    }
  });

  it("rejects missing or invalid internal timestamps before exposing a loaded database", () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const plugins = pluginDistributions.map((filename) => require(join(root, "dist/plugins", filename)));
    const canonical = "2026-08-08T12:34:56.789Z";
    const invalidCases = [
      {
        label: "missing database createdAt",
        mutate(data: Record<string, any>): void {
          delete data.createdAt;
        }
      },
      {
        label: "missing database modifiedAt",
        mutate(data: Record<string, any>): void {
          delete data.modifiedAt;
        }
      },
      {
        label: "missing collection createdAt",
        mutate(data: Record<string, any>): void {
          delete data.collections.records.createdAt;
        }
      },
      {
        label: "missing collection modifiedAt",
        mutate(data: Record<string, any>): void {
          delete data.collections.records.modifiedAt;
        }
      },
      {
        label: "missing document $createdAt",
        mutate(data: Record<string, any>): void {
          delete data.collections.records.data[0].$createdAt;
        }
      },
      {
        label: "missing document $modifiedAt",
        mutate(data: Record<string, any>): void {
          delete data.collections.records.data[0].$modifiedAt;
        }
      },
      {
        label: "database createdAt",
        mutate(data: Record<string, any>): void {
          data.createdAt = "2026-08-08";
        }
      },
      {
        label: "database modifiedAt",
        mutate(data: Record<string, any>): void {
          data.modifiedAt = null;
        }
      },
      {
        label: "collection createdAt",
        mutate(data: Record<string, any>): void {
          data.collections.records.createdAt = "invalid";
        }
      },
      {
        label: "collection modifiedAt",
        mutate(data: Record<string, any>): void {
          data.collections.records.modifiedAt = 0;
        }
      },
      {
        label: "document $createdAt",
        mutate(data: Record<string, any>): void {
          data.collections.records.data[0].$createdAt = canonical.slice(0, -1);
        }
      },
      {
        label: "document $modifiedAt",
        mutate(data: Record<string, any>): void {
          data.collections.records.data[0].$modifiedAt = {};
        }
      }
    ];

    for (let bundleIndex = 0; bundleIndex < plugins.length; bundleIndex += 1) {
      for (let index = 0; index < invalidCases.length; index += 1) {
        const invalidCase = invalidCases[index];
        const databaseFile = join(workspace, `invalid-metadata-${bundleIndex}-${index}.json`);
        const data = {
          collections: {
            records: {
              data: [
                {
                  $id: 1,
                  $createdAt: canonical,
                  $modifiedAt: canonical
                }
              ],
              index: 1,
              createdAt: canonical,
              modifiedAt: canonical
            }
          },
          createdAt: canonical,
          modifiedAt: canonical
        };
        invalidCase.mutate(data);
        writeFileSync(databaseFile, JSON.stringify(data));
        const serialized = readFileSync(databaseFile, "utf8");
        let loaded: unknown = null;
        let error: unknown = null;

        try {
          const candidate = IluDB({ adapter: plugins[bundleIndex] });
          candidate.load(databaseFile);
          loaded = candidate;
        } catch (caught) {
          error = caught;
        }

        expect(loaded, invalidCase.label).toBeNull();
        expect(error, invalidCase.label).toBeInstanceOf(Error);
        expect(readFileSync(databaseFile, "utf8"), invalidCase.label).toBe(serialized);
      }
    }
  });

  it("restores only IluDB timestamps in both Node JSON plugin bundles", () => {
    for (let index = 0; index < pluginDistributions.length; index += 1) {
      const databaseFile = join(workspace, `timestamps-${index}.json`);
      run({
        command: [
          "node",
          "-e",
          `
const IluDB = require(${JSON.stringify(join(root, "dist/iludb.js"))});
const plugin = require(${JSON.stringify(join(root, "dist/plugins", pluginDistributions[index]))});
const userTimestamp = "2026-08-08T12:34:56.789Z";
const database = IluDB({ adapter: plugin });
database.load(${JSON.stringify(databaseFile)});
const records = database.getCollection("records");
const added = records.add({
    isoString: userTimestamp,
    arbitraryDate: new Date(userTimestamp),
});
const expected = {
    databaseCreatedAt: database.snapshot().createdAt.getTime(),
    databaseModifiedAt: database.snapshot().modifiedAt.getTime(),
    collectionCreatedAt: database.snapshot().collections.records.createdAt.getTime(),
    collectionModifiedAt: database.snapshot().collections.records.modifiedAt.getTime(),
    documentCreatedAt: added.$createdAt.getTime(),
    documentModifiedAt: added.$modifiedAt.getTime(),
};

const loaded = IluDB({ adapter: plugin });
loaded.load(${JSON.stringify(databaseFile)});
const collectionData = loaded.snapshot().collections.records;
const document = loaded.getCollection("records").findOne({ $id: added.$id });
const timestamps = [
    [loaded.snapshot().createdAt, expected.databaseCreatedAt],
    [loaded.snapshot().modifiedAt, expected.databaseModifiedAt],
    [collectionData.createdAt, expected.collectionCreatedAt],
    [collectionData.modifiedAt, expected.collectionModifiedAt],
    [document.$createdAt, expected.documentCreatedAt],
    [document.$modifiedAt, expected.documentModifiedAt],
];
for (const [timestamp, instant] of timestamps) {
    if (!(timestamp instanceof Date)) throw new Error("internal timestamp was not restored");
    if (timestamp.getTime() !== instant) throw new Error("internal timestamp changed instant");
}
if (document.isoString !== userTimestamp || typeof document.isoString !== "string") {
    throw new Error("user ISO string was converted");
}
if (document.arbitraryDate !== userTimestamp || typeof document.arbitraryDate !== "string") {
    throw new Error("user Date did not retain standard JSON behavior");
}
`
        ]
      });
    }
  });

  it("surfaces serialization and filesystem errors synchronously", () => {
    const databaseFile = join(workspace, "recoverable-errors.json");
    run({
      command: [
        "node",
        "-e",
        `
const fs = require("node:fs");
const IluDB = require(${JSON.stringify(join(root, "dist/iludb.js"))});
const plugin = require(${JSON.stringify(join(root, "dist/plugins/node-json.js"))});
const database = IluDB({ adapter: plugin });
database.load(${JSON.stringify(databaseFile)});
const now = new Date();
const cyclic = {
    value: "cyclic",
    $id: 1,
    $createdAt: now,
    $modifiedAt: now,
};
cyclic.self = cyclic;
let serializationFailed = false;
try {
    database.transaction(tx => tx.getCollection("records").add({ value: cyclic }));
} catch (error) {
    serializationFailed = error instanceof Error;
}
if (!serializationFailed) throw new Error("save hid the serialization error");
delete cyclic.self;
database.save();
const records = database.getCollection("records");
fs.renameSync(${JSON.stringify(databaseFile)}, ${JSON.stringify(`${databaseFile}.original`)});
fs.mkdirSync(${JSON.stringify(databaseFile)});
let writeFailed = false;
try {
    records.add({ value: "write-error" });
} catch (error) {
    writeFailed = error && error.code === "IO";
}
if (!writeFailed) throw new Error("add hid the synchronous write error");
`
      ]
    });
  });
});
