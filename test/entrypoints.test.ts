import { beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { createContext, runInContext } from "vm";
import nodeJSONPluginSource from "../src/plugins/node-json";

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

function loadPluginWithFs(fsAdapter: Record<string, any>): any {
  const source = readFileSync(join(root, "dist/plugins/node-json.js"), "utf8");
  let plugin: any = null;
  const define = (_dependencies: string[], factory: (fs: any) => any): void => {
    plugin = factory(fsAdapter);
  };
  (define as any).amd = {};
  const context = {
    AggregateError,
    Buffer,
    define,
    process
  };
  createContext(context);
  runInContext(source, context);
  return plugin;
}

function restoreHostPlugin(IluDB: any): void {
  IluDB.use((target: any) => nodeJSONPluginSource(target));
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

function listFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = readdirSync(current, { withFileTypes: true });
    for (let index = 0; index < entries.length; index += 1) {
      const path = join(current, entries[index].name);
      if (entries[index].isDirectory()) {
        pending.push(path);
      } else {
        files.push(relative(directory, path));
      }
    }
  }
  return files.sort();
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

describe("Public entrypoints", () => {
  it("reloads transactionally and keeps collection bindings stable", () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const plugin = require(join(root, "dist/plugins/node-json.js"));
    IluDB.use(plugin);
    const databaseFile = join(workspace, "reload-bindings.json");
    const database = IluDB(databaseFile);
    const first = database.getCollection("records");
    const second = database.getCollection("records");
    first.createIndex("by-state", "state");
    first.createTextIndex("content", "body");
    first.add({ state: "local", body: "local token" });
    const stableSnapshot = JSON.parse(readFileSync(databaseFile, "utf8"));
    const dataReference = database.data;

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
      expect(() => database.reload(), invalid.label).toThrow(TypeError);
      expect(database.data, invalid.label).toBe(dataReference);
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
    expect(() => first.find()).toThrow("inactive");
    expect(() => second.reindex()).toThrow("inactive");
    const recreated = database.getCollection("records");
    expect(recreated.find()).toEqual([]);
    expect(recreated.getIndexes()).toEqual([{ name: "by-state", fields: ["state"] }]);
    expect(recreated.getTextIndexes()).toEqual([{ name: "content", fields: ["body"] }]);
    expect(first.find()).toEqual([]);
  });

  it("persists revisions and rejects stale or disappeared snapshots", () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const plugin = require(join(root, "dist/plugins/node-json.js"));
    IluDB.use(plugin);
    const databaseFile = join(workspace, "revision-conflicts.json");
    const created = IluDB(databaseFile);
    expect(created.data.revision).toBe(0);
    const legacy = JSON.parse(readFileSync(databaseFile, "utf8"));
    delete legacy.revision;
    writeFileSync(databaseFile, JSON.stringify(legacy));
    const first = IluDB(databaseFile);
    expect(first.data.revision).toBe(0);
    first.save();
    expect(JSON.parse(readFileSync(databaseFile, "utf8")).revision).toBe(1);

    const stale = IluDB(databaseFile);
    first.save();
    const beforeConflict = stale.data;
    stale.data.local = "preserved";
    let conflict: any = null;
    try {
      stale.save();
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(plugin.ConflictError);
    expect(conflict.expectedRevision).toBe(1);
    expect(conflict.actualRevision).toBe(2);
    expect(stale.data).toBe(beforeConflict);
    expect(stale.data.local).toBe("preserved");

    const moved = `${databaseFile}.moved`;
    renameSync(databaseFile, moved);
    expect(() => first.save()).toThrow(plugin.ConflictError);
    try {
      first.save();
    } catch (error: any) {
      expect(error.actualRevision).toBeNull();
    }
  });

  it("retries reload when the path changes after the descriptor read", () => {
    const nodeFs = require("fs") as Record<string, any>;
    const IluDB = require(join(root, "dist/iludb.js"));
    let armed = false;
    let databaseFile = "";
    let latestSerialized = "";
    const adapter = {
      ...nodeFs,
      readFileSync(...args: any[]): any {
        const result = nodeFs.readFileSync.apply(null, args);
        if (armed) {
          armed = false;
          const replacement = `${databaseFile}.race-replacement`;
          nodeFs.writeFileSync(replacement, latestSerialized);
          nodeFs.renameSync(replacement, databaseFile);
        }
        return result;
      }
    };
    const plugin = loadPluginWithFs(adapter);
    IluDB.use(plugin);
    databaseFile = join(workspace, "reload-race.json");
    const database = IluDB(databaseFile);
    const older = JSON.parse(readFileSync(databaseFile, "utf8"));
    older.revision = 1;
    older.marker = "older";
    writeFileSync(databaseFile, JSON.stringify(older));
    const latest = structuredClone(older);
    latest.revision = 2;
    latest.marker = "latest";
    latestSerialized = JSON.stringify(latest);
    armed = true;

    database.reload();

    expect(database.data.revision).toBe(2);
    expect(database.data.marker).toBe("latest");
    restoreHostPlugin(IluDB);
  });

  it("publishes saves through an atomic replacement and preserves mode", () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const plugin = require(join(root, "dist/plugins/node-json.js"));
    IluDB.use(plugin);
    const databaseFile = join(workspace, "atomic-save.json");
    const database = IluDB(databaseFile);
    chmodSync(databaseFile, 0o640);
    const inode = lstatSync(databaseFile).ino;
    database.data.value = "published";
    database.save();
    expect(lstatSync(databaseFile).ino).not.toBe(inode);
    expect(lstatSync(databaseFile).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(databaseFile, "utf8")).value).toBe("published");

    const target = join(workspace, "symlink-target.json");
    const link = join(workspace, "symlink-database.json");
    writeFileSync(target, readFileSync(databaseFile));
    symlinkSync(target, link);
    database.dir = link;
    expect(() => database.save()).toThrow(TypeError);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("keeps atomic save failures before rename from publishing state", () => {
    const nodeFs = require("fs") as Record<string, any>;
    const IluDB = require(join(root, "dist/iludb.js"));
    const stages = ["openSync", "writeSync", "fchmodSync", "fsyncSync", "closeSync", "renameSync"];
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      let armed = false;
      let cleanupCalls = 0;
      const adapter: Record<string, any> = {
        ...nodeFs,
        unlinkSync(...args: any[]): void {
          cleanupCalls += 1;
          nodeFs.unlinkSync.apply(null, args);
        }
      };
      adapter[stage] = (...args: any[]): any => {
        if (armed) {
          armed = false;
          throw new Error(`${stage} boundary failure`);
        }
        return nodeFs[stage](...args);
      };
      const plugin = loadPluginWithFs(adapter);
      IluDB.use(plugin);
      const databaseFile = join(workspace, `atomic-${stage}.json`);
      const database = IluDB(databaseFile);
      const serialized = readFileSync(databaseFile, "utf8");
      const revision = database.data.revision;
      const modifiedAt = database.data.modifiedAt;
      database.data.stage = stage;
      armed = true;

      expect(() => database.save(), stage).toThrow(`${stage} boundary failure`);
      expect(readFileSync(databaseFile, "utf8"), stage).toBe(serialized);
      expect(database.data.revision, stage).toBe(revision);
      expect(database.data.modifiedAt, stage).toBe(modifiedAt);
      expect(cleanupCalls, stage).toBe(stage === "openSync" ? 0 : 1);
      expect(
        readdirSync(workspace).filter((name) => name.startsWith(`atomic-${stage}.json.tmp-`)),
        stage
      ).toEqual([]);
    }
    restoreHostPlugin(IluDB);
  });

  it("completes partial writes and preserves the primary cleanup error", () => {
    const nodeFs = require("fs") as Record<string, any>;
    const IluDB = require(join(root, "dist/iludb.js"));
    const partialPlugin = loadPluginWithFs({
      ...nodeFs,
      writeSync(descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
        return nodeFs.writeSync(descriptor, buffer, offset, Math.min(length, 3), position);
      }
    });
    IluDB.use(partialPlugin);
    const partialFile = join(workspace, "partial-write.json");
    const partialDatabase = IluDB(partialFile);
    partialDatabase.data.payload = "complete";
    partialDatabase.save();
    expect(JSON.parse(readFileSync(partialFile, "utf8")).payload).toBe("complete");

    let armed = false;
    const cleanupPlugin = loadPluginWithFs({
      ...nodeFs,
      writeSync(...args: any[]): number {
        if (armed) {
          throw new Error("primary write failure");
        }
        return nodeFs.writeSync.apply(null, args);
      },
      unlinkSync(path: string): void {
        if (armed && path.includes(".tmp-")) {
          throw new Error("secondary cleanup failure");
        }
        nodeFs.unlinkSync(path);
      }
    });
    IluDB.use(cleanupPlugin);
    const cleanupFile = join(workspace, "cleanup-failure.json");
    const cleanupDatabase = IluDB(cleanupFile);
    armed = true;
    let aggregate: any = null;
    try {
      cleanupDatabase.save();
    } catch (error) {
      aggregate = error;
    }
    armed = false;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.errors[0].message).toBe("primary write failure");
    expect(aggregate.errors[1].message).toBe("secondary cleanup failure");
    restoreHostPlugin(IluDB);
  });

  it("watches external replacements, contains callback errors and ignores own saves", async () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const plugin = require(join(root, "dist/plugins/node-json.js"));
    IluDB.use(plugin);
    const databaseFile = join(workspace, "watched.json");
    const database = IluDB(databaseFile);
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
    database.data.own = true;
    database.save();
    await Bun.sleep(80);
    expect(reloads).toBe(0);

    const external = JSON.parse(readFileSync(databaseFile, "utf8"));
    external.revision += 1;
    external.external = true;
    const replacement = `${databaseFile}.replacement`;
    writeFileSync(replacement, JSON.stringify(external));
    renameSync(replacement, databaseFile);
    await waitFor(() => reloads === 1);
    expect(database.data.external).toBe(true);
    expect(errors).toBe(1);
    database.unwatch();
    database.unwatch();
  });

  it("keeps watching through invalid, deleted and reappearing files without callbacks", async () => {
    const IluDB = require(join(root, "dist/iludb.js"));
    const plugin = require(join(root, "dist/plugins/node-json.js"));
    IluDB.use(plugin);
    const databaseFile = join(workspace, "watch-recovery.json");
    const database = IluDB(databaseFile);
    const originalReference = database.data;
    expect(() => database.watch({ interval: 0 })).toThrow(TypeError);
    expect(() => database.watch({ onReload: true })).toThrow(TypeError);
    expect(() => database.watch({ onError: true })).toThrow(TypeError);
    database.watch({ interval: 20 });
    database.watch({ interval: 0 });

    const replacement = `${databaseFile}.replacement`;
    writeFileSync(replacement, "{");
    renameSync(replacement, databaseFile);
    await Bun.sleep(80);
    expect(database.data).toBe(originalReference);

    const valid = {
      ...JSON.parse(readFileSync(join(workspace, "watched.json"), "utf8")),
      recovered: 1
    };
    writeFileSync(replacement, JSON.stringify(valid));
    renameSync(replacement, databaseFile);
    await waitFor(() => database.data.recovered === 1);

    const missing = `${databaseFile}.missing`;
    renameSync(databaseFile, missing);
    await Bun.sleep(80);
    expect(database.data.recovered).toBe(1);
    valid.revision += 1;
    valid.recovered = 2;
    writeFileSync(databaseFile, JSON.stringify(valid));
    await waitFor(() => database.data.recovered === 2);
    database.unwatch();
  });

  it("configures a non-persistent watcher and unregisters its exact listener", () => {
    const nodeFs = require("fs") as Record<string, any>;
    const IluDB = require(join(root, "dist/iludb.js"));
    let watchedPath: string | null = null;
    let watchedListener: unknown = null;
    let watchedOptions: Record<string, any> | null = null;
    let unwatchedPath: string | null = null;
    let unwatchedListener: unknown = null;
    const adapter = {
      ...nodeFs,
      watchFile(path: string, options: Record<string, any>, listener: unknown): void {
        watchedPath = path;
        watchedOptions = options;
        watchedListener = listener;
      },
      unwatchFile(path: string, listener: unknown): void {
        unwatchedPath = path;
        unwatchedListener = listener;
      }
    };
    const plugin = loadPluginWithFs(adapter);
    IluDB.use(plugin);
    const databaseFile = join(workspace, "watch-adapter.json");
    const database = IluDB(databaseFile);
    database.watch();
    database.watch();
    database.dir = `${databaseFile}.other`;
    database.unwatch();

    expect(watchedPath as unknown).toBe(databaseFile);
    expect(watchedOptions as unknown).toEqual({
      interval: 500,
      persistent: false
    });
    expect(unwatchedPath as unknown).toBe(databaseFile);
    expect(unwatchedListener).toBe(watchedListener);
    restoreHostPlugin(IluDB);
  });

  it("coalesces watch events during reload into one additional read", () => {
    const nodeFs = require("fs") as Record<string, any>;
    const IluDB = require(join(root, "dist/iludb.js"));
    let listener: ((current: any, previous: any) => void) | null = null;
    let watchedPath: string | null = null;
    let triggerBurst = false;
    let reloadReads = 0;
    const adapter = {
      ...nodeFs,
      watchFile(
        path: string,
        _options: Record<string, any>,
        nextListener: (current: any, previous: any) => void
      ): void {
        watchedPath = path;
        listener = nextListener;
      },
      unwatchFile(): void {},
      readFileSync(...args: any[]): any {
        const result = nodeFs.readFileSync.apply(null, args);
        if (triggerBurst && watchedPath !== null) {
          triggerBurst = false;
          reloadReads += 1;
          const first = {
            ctimeMs: 101,
            dev: 1,
            ino: 1,
            mtimeMs: 101,
            size: 101
          };
          const second = {
            ctimeMs: 102,
            dev: 1,
            ino: 1,
            mtimeMs: 102,
            size: 102
          };
          listener!(first, first);
          listener!(second, second);
        } else if (watchedPath !== null) {
          reloadReads += 1;
        }
        return result;
      }
    };
    const plugin = loadPluginWithFs(adapter);
    IluDB.use(plugin);
    const databaseFile = join(workspace, "watch-coalescing.json");
    const database = IluDB(databaseFile);
    database.watch();
    const external = JSON.parse(readFileSync(databaseFile, "utf8"));
    external.revision += 1;
    external.burst = true;
    writeFileSync(databaseFile, JSON.stringify(external));
    triggerBurst = true;
    const current = lstatSync(databaseFile);
    listener!(current, current);

    database.unwatch();
    restoreHostPlugin(IluDB);
    expect(database.data.burst).toBe(true);
    expect(reloadReads).toBe(2);
  });

  it("lets a subprocess exit while its non-persistent watcher is active", () => {
    const databaseFile = join(workspace, "watch-subprocess.json");
    run({
      command: [
        "node",
        "-e",
        `
const IluDB = require(${JSON.stringify(join(root, "dist/iludb.js"))});
const plugin = require(${JSON.stringify(join(root, "dist/plugins/node-json.js"))});
IluDB.use(plugin);
const database = IluDB(${JSON.stringify(databaseFile)});
database.watch({ interval: 20 });
`
      ]
    });
  });

  it("loads readable, minified and package CommonJS exports", () => {
    run({
      cwd: workspace,
      command: [
        "node",
        "-e",
        `
const exportsToCheck = [
    require("iludb"),
    require("iludb/plugins/node-json"),
    require(${JSON.stringify(join(root, "dist/iludb.js"))}),
    require(${JSON.stringify(join(root, "dist/iludb.min.js"))}),
    require(${JSON.stringify(join(root, "dist/plugins/node-json.js"))}),
    require(${JSON.stringify(join(root, "dist/plugins/node-json.min.js"))}),
];
for (const value of exportsToCheck) {
    if (typeof value !== "function") throw new Error("CommonJS export is not callable");
}
`
      ]
    });
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
IluDB.use(plugin);
const database = IluDB(${JSON.stringify(databaseFile)});
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
        field: "database.createdAt",
        mutate(data: Record<string, any>): void {
          delete data.createdAt;
        }
      },
      {
        label: "missing database modifiedAt",
        field: "database.modifiedAt",
        mutate(data: Record<string, any>): void {
          delete data.modifiedAt;
        }
      },
      {
        label: "missing collection createdAt",
        field: 'database.collections["records"].createdAt',
        mutate(data: Record<string, any>): void {
          delete data.collections.records.createdAt;
        }
      },
      {
        label: "missing collection modifiedAt",
        field: 'database.collections["records"].modifiedAt',
        mutate(data: Record<string, any>): void {
          delete data.collections.records.modifiedAt;
        }
      },
      {
        label: "missing document $createdAt",
        field: 'database.collections["records"].data[0].$createdAt',
        mutate(data: Record<string, any>): void {
          delete data.collections.records.data[0].$createdAt;
        }
      },
      {
        label: "missing document $modifiedAt",
        field: 'database.collections["records"].data[0].$modifiedAt',
        mutate(data: Record<string, any>): void {
          delete data.collections.records.data[0].$modifiedAt;
        }
      },
      {
        label: "database createdAt",
        field: "database.createdAt",
        mutate(data: Record<string, any>): void {
          data.createdAt = "2026-08-08";
        }
      },
      {
        label: "database modifiedAt",
        field: "database.modifiedAt",
        mutate(data: Record<string, any>): void {
          data.modifiedAt = null;
        }
      },
      {
        label: "collection createdAt",
        field: 'database.collections["records"].createdAt',
        mutate(data: Record<string, any>): void {
          data.collections.records.createdAt = "invalid";
        }
      },
      {
        label: "collection modifiedAt",
        field: 'database.collections["records"].modifiedAt',
        mutate(data: Record<string, any>): void {
          data.collections.records.modifiedAt = 0;
        }
      },
      {
        label: "document $createdAt",
        field: 'database.collections["records"].data[0].$createdAt',
        mutate(data: Record<string, any>): void {
          data.collections.records.data[0].$createdAt = canonical.slice(0, -1);
        }
      },
      {
        label: "document $modifiedAt",
        field: 'database.collections["records"].data[0].$modifiedAt',
        mutate(data: Record<string, any>): void {
          data.collections.records.data[0].$modifiedAt = {};
        }
      }
    ];

    for (let bundleIndex = 0; bundleIndex < plugins.length; bundleIndex += 1) {
      IluDB.use(plugins[bundleIndex]);
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
          loaded = IluDB(databaseFile);
        } catch (caught) {
          error = caught;
        }

        expect(loaded, invalidCase.label).toBeNull();
        expect(error, invalidCase.label).toBeInstanceOf(TypeError);
        expect((error as Error).message, invalidCase.label).toContain(invalidCase.field);
        expect((error as Error).message, invalidCase.label).toContain("canonical ISO timestamp");
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
IluDB.use(plugin);
const userTimestamp = "2026-08-08T12:34:56.789Z";
const database = IluDB(${JSON.stringify(databaseFile)});
const records = database.getCollection("records");
const added = records.add({
    isoString: userTimestamp,
    arbitraryDate: new Date(userTimestamp),
});
const expected = {
    databaseCreatedAt: database.data.createdAt.getTime(),
    databaseModifiedAt: database.data.modifiedAt.getTime(),
    collectionCreatedAt: database.data.collections.records.createdAt.getTime(),
    collectionModifiedAt: database.data.collections.records.modifiedAt.getTime(),
    documentCreatedAt: added.$createdAt.getTime(),
    documentModifiedAt: added.$modifiedAt.getTime(),
};

const loaded = IluDB(${JSON.stringify(databaseFile)});
const collectionData = loaded.data.collections.records;
const document = loaded.getCollection("records").findOne({ $id: added.$id });
const timestamps = [
    [loaded.data.createdAt, expected.databaseCreatedAt],
    [loaded.data.modifiedAt, expected.databaseModifiedAt],
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
const IluDB = require(${JSON.stringify(join(root, "dist/iludb.js"))});
const plugin = require(${JSON.stringify(join(root, "dist/plugins/node-json.js"))});
IluDB.use(plugin);
const database = IluDB(${JSON.stringify(databaseFile)});
const now = new Date();
const cyclic = {
    value: "cyclic",
    $id: 1,
    $createdAt: now,
    $modifiedAt: now,
};
cyclic.self = cyclic;
database.data.collections.records = {
    data: [cyclic],
    index: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
};
let serializationFailed = false;
try {
    database.save();
} catch (error) {
    serializationFailed = error instanceof TypeError;
}
if (!serializationFailed) throw new Error("save hid the serialization error");
delete cyclic.self;
database.save();
const records = database.getCollection("records");
database.dir = ${JSON.stringify(workspace)};
let writeFailed = false;
try {
    records.add({ value: "write-error" });
} catch (error) {
    writeFailed = error instanceof TypeError || (error && (error.code === "EISDIR" || error.code === "EACCES" || error.code === "EPERM"));
}
if (!writeFailed) throw new Error("add hid the synchronous write error");
`
      ]
    });
  });

  it("isolates CommonJS and AMD globals while exposing the global format", () => {
    for (let index = 0; index < distributions.length; index += 1) {
      const bundlePath = JSON.stringify(join(root, "dist", distributions[index]));
      run({
        command: [
          "node",
          "-e",
          `
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(${bundlePath}, "utf8");
const sentinel = {};

for (const existingGlobal of [false, true]) {
    const commonjs = {
        module: { exports: {} },
        require,
        ...(existingGlobal ? { IluDB: sentinel } : {}),
    };
    vm.createContext(commonjs);
    vm.runInContext(source, commonjs);
    if (typeof commonjs.module.exports !== "function") {
        throw new Error("CommonJS export is missing");
    }
    if (existingGlobal ? commonjs.IluDB !== sentinel : Object.hasOwn(commonjs, "IluDB")) {
        throw new Error("CommonJS contaminated the global");
    }

    let amdExport;
    const define = (factory) => { amdExport = factory(); };
    define.amd = {};
    const amd = {
        define,
        ...(existingGlobal ? { IluDB: sentinel } : {}),
    };
    vm.createContext(amd);
    vm.runInContext(source, amd);
    if (typeof amdExport !== "function") throw new Error("AMD export is missing");
    if (existingGlobal ? amd.IluDB !== sentinel : Object.hasOwn(amd, "IluDB")) {
        throw new Error("AMD contaminated the global");
    }
}

const browser = { IluDB: sentinel };
vm.createContext(browser);
vm.runInContext(source, browser);
if (typeof browser.IluDB !== "function" || browser.IluDB === sentinel) {
    throw new Error("browser global is missing");
}
`
        ]
      });
    }
  });

  it("exposes equivalent plugin formats when the runtime provides fs", () => {
    for (let index = 0; index < pluginDistributions.length; index += 1) {
      const bundlePath = JSON.stringify(join(root, "dist/plugins", pluginDistributions[index]));
      run({
        command: [
          "node",
          "-e",
          `
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(${bundlePath}, "utf8");
let amdExport;
const define = (dependencies, factory) => {
    if (dependencies.length !== 1 || dependencies[0] !== "fs") {
        throw new Error("AMD external dependency changed");
    }
    amdExport = factory(fs);
};
define.amd = {};
const amd = { define };
vm.createContext(amd);
vm.runInContext(source, amd);
if (typeof amdExport !== "function") throw new Error("plugin AMD export is missing");
const globalContext = { require };
vm.createContext(globalContext);
vm.runInContext(source, globalContext);
if (typeof globalContext.IluDBNodeJSONPlugin !== "function") {
    throw new Error("plugin global is missing");
}
`
        ]
      });
    }
  });

  it("fails honestly when the plugin runtime cannot provide fs", () => {
    const source = readFileSync(join(root, "dist/plugins/node-json.js"), "utf8");
    expect(() => {
      const result = Bun.spawnSync(
        [
          "node",
          "-e",
          `
const vm = require("node:vm");
const context = {};
vm.createContext(context);
vm.runInContext(${JSON.stringify(source)}, context);
`
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      if (result.exitCode === 0) {
        throw new Error("plugin loaded without fs");
      }
    }).not.toThrow();
  });

  it("publishes only the explicit distribution inventory", () => {
    expect(listFiles(packedPackage)).toEqual([
      "LICENSE",
      "README.md",
      "dist/iludb.d.ts",
      "dist/iludb.js",
      "dist/iludb.min.js",
      "dist/plugins/node-json.d.ts",
      "dist/plugins/node-json.js",
      "dist/plugins/node-json.min.js",
      "package.json"
    ]);
    expect(existsSync(join(root, "index.js"))).toBe(false);
    expect(existsSync(join(root, "lib"))).toBe(false);
    expect(existsSync(join(root, "plugins"))).toBe(false);
  });

  it("publishes consumable TypeScript declarations for ESM and CommonJS", () => {
    writeFileSync(
      join(workspace, "consumer.mts"),
      `
import IluDB from "iludb";
import nodeJSONPlugin from "iludb/plugins/node-json";

interface Article {
    title: string;
    body: string;
    score: number;
    status: "draft" | "published";
}

const database: IluDB.Database = IluDB();
const articles: IluDB.Collection<Article> = database.getCollection<Article>("articles");
const added = articles.add({
    title: "Types are public",
    body: "Exact and text indexes",
    score: 1,
    status: "draft",
});

if (added) {
    added.$id;
    added.$createdAt.toISOString();
    const coreCreatedAt: Date = added.$createdAt;
    articles.update({ ...added, status: "published" });
    articles.remove(added);
}

const found = articles.find(
    { status: "draft" },
    { sort: { score: -1 } },
);
found[0]?.title.toUpperCase();
articles.findOne({ title: "Types are public" })?.body.toUpperCase();
articles.sort(found, { score: 1 });
articles.count({ status: "published" });
articles.get(1)?.score.toFixed();
articles.createIndex("by-status", "status");
articles.createIndex("by-status-score", ["status", "score"]);
articles.getIndexes()[0]?.fields;
articles.dropIndex("by-status");
articles.createTextIndex("content", ["title", "body"]);
articles.searchText("content", "public indexes", { operator: "OR" });
articles.getTextIndexes()[0]?.name;
articles.dropTextIndex("content");
articles.reindex().count();
const saved: void = database.save();

IluDB.use(nodeJSONPlugin);
const jsonDatabase = IluDB("./tmp/database.json");
jsonDatabase.dir.toUpperCase();
const jsonDatabaseCreatedAt: Date = jsonDatabase.data.createdAt;
jsonDatabase.data.modifiedAt.toISOString();
jsonDatabase.data.revision.toFixed();
const jsonSaved: void = jsonDatabase.save();
const jsonReloaded: void = jsonDatabase.reload();
const jsonWatched: void = jsonDatabase.watch({
    interval: 500,
    onReload(reloaded) {
        reloaded.data.revision.toFixed();
    },
    onError(error) {
        error.message.toUpperCase();
    },
});
const jsonUnwatched: void = jsonDatabase.unwatch();
const conflictConstructor: typeof nodeJSONPlugin.ConflictError =
    nodeJSONPlugin.ConflictError;
const jsonArticles = jsonDatabase.getCollection<Article>("articles");
const jsonArticle = jsonArticles.add({
    title: "Persisted types",
    body: "JSON metadata can be serialized",
    score: 2,
    status: "draft",
});
const jsonCollectionCreatedAt: Date =
    jsonDatabase.data.collections.articles.createdAt;
jsonDatabase.data.collections.articles.modifiedAt.toISOString();
if (jsonArticle) {
    const jsonCreatedAt: Date = jsonArticle.$createdAt;
    jsonArticle.$createdAt.toISOString();
}

// @ts-expect-error in-memory databases do not expose the JSON file path
database.dir;
// @ts-expect-error in-memory databases do not expose persisted revisions
database.data.revision;
// @ts-expect-error sort directions are limited to 1 and -1
articles.find({}, { sort: { score: 0 } });
// @ts-expect-error queries only accept document fields
articles.find({ missing: true });
// @ts-expect-error index fields only accept document fields
articles.createIndex("missing", "missing");
// @ts-expect-error text operators are limited to AND and OR
articles.searchText("content", "query", { operator: "XOR" });
// @ts-expect-error reserved metadata is assigned by IluDB
articles.add({ title: "x", body: "x", score: 1, status: "draft", $id: 1 });
// @ts-expect-error save is synchronous
const pendingSave: Promise<void> = jsonDatabase.save();
// @ts-expect-error internal helpers are not public
IluDB.tokenize("hidden");
// @ts-expect-error runtime postings are not public
articles.postings;
`
    );
    writeFileSync(
      join(workspace, "consumer-commonjs.cts"),
      `
import IluDB = require("iludb");
import nodeJSONPlugin = require("iludb/plugins/node-json");

IluDB.use(nodeJSONPlugin);
const database = IluDB("./tmp/commonjs.json");
const records = database.getCollection<{ name: string }>("records");
records.add({ name: "CommonJS" });
database.dir.toUpperCase();
const saved: void = database.save();
database.reload();
database.watch();
database.unwatch();
database.data.revision.toFixed();
nodeJSONPlugin.ConflictError;
`
    );
    writeFileSync(
      join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          esModuleInterop: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
          types: []
        },
        files: ["consumer.mts", "consumer-commonjs.cts"]
      })
    );

    run({
      cwd: workspace,
      command: [join(root, "node_modules", ".bin", "tsc"), "--project", "tsconfig.json"]
    });
  });

  it("keeps readable outputs larger and more legible than minified outputs", () => {
    const pairs = [
      ["dist/iludb.js", "dist/iludb.min.js"],
      ["dist/plugins/node-json.js", "dist/plugins/node-json.min.js"]
    ];
    for (let index = 0; index < pairs.length; index += 1) {
      const readable = readFileSync(join(root, pairs[index][0]), "utf8");
      const minified = readFileSync(join(root, pairs[index][1]), "utf8");
      expect(readable.length).toBeGreaterThan(minified.length);
      expect(readable.split("\n").length).toBeGreaterThan(20);
      expect(minified.split("\n").length).toBeLessThan(5);
    }
  });
});
