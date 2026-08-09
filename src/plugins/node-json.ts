import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeSync
} from "fs";
import type { Stats } from "fs";

interface IluDBPluginTarget {
  getDatabase: (...args: any[]) => any;
  getCollection: (database: any, name: string) => any;
  plugify: (object: any) => void;
  _stageData: (database: any, data: any) => any;
  _publishData: (database: any, staged: any) => void;
}

interface WatchOptions {
  interval?: number;
  onReload?: (database: NodeJSONDatabase) => void;
  onError?: (error: Error) => void;
}

interface NodeJSONDatabase {
  dir: string;
  data: any;
  getCollection(name: string): any;
  save(): void;
  reload(): void;
  watch(options?: WatchOptions): void;
  unwatch(): void;
}

type WatchState = "stopped" | "idle" | "processing" | "pending";

interface StableSnapshot {
  data: Record<string, any>;
  signature: string;
}

let temporaryCounter = 0;

class ConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number | null;

  constructor(expectedRevision: number, actualRevision: number | null) {
    super(`The persisted snapshot revision changed from ${expectedRevision} to ${String(actualRevision)}.`);
    this.name = "ConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, any> {
  if (!isPlainObject(value)) {
    throw new TypeError(`Invalid IluDB object at ${path}.`);
  }
}

function restoreTimestamp({ owner, key, path }: { owner: Record<string, any>; key: string; path: string }): void {
  if (!Object.hasOwn(owner, key)) {
    throw new TypeError(`Missing IluDB timestamp at ${path}: expected a canonical ISO timestamp string.`);
  }
  const value = owner[key];
  if (typeof value !== "string") {
    throw new TypeError(`Invalid IluDB timestamp at ${path}: expected a canonical ISO timestamp string.`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`Invalid IluDB timestamp at ${path}: expected a canonical ISO timestamp string.`);
  }
  owner[key] = timestamp;
}

function validateAndRestore(data: unknown): Record<string, any> {
  assertPlainObject(data, "database");
  const revision = Object.hasOwn(data, "revision") ? data.revision : 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("Invalid IluDB revision at database.revision: expected a non-negative safe integer.");
  }
  data.revision = revision;
  restoreTimestamp({ owner: data, key: "createdAt", path: "database.createdAt" });
  restoreTimestamp({
    owner: data,
    key: "modifiedAt",
    path: "database.modifiedAt"
  });
  assertPlainObject(data.collections, "database.collections");

  const names = Object.keys(data.collections);
  for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
    const name = names[nameIndex];
    const collection = data.collections[name];
    const collectionPath = `database.collections[${JSON.stringify(name)}]`;
    assertPlainObject(collection, collectionPath);
    if (!Array.isArray(collection.data)) {
      throw new TypeError(`Invalid IluDB array at ${collectionPath}.data.`);
    }
    if (!Number.isSafeInteger(collection.index) || collection.index < 0) {
      throw new TypeError(`Invalid IluDB index at ${collectionPath}.index: expected a non-negative safe integer.`);
    }
    restoreTimestamp({
      owner: collection,
      key: "createdAt",
      path: `${collectionPath}.createdAt`
    });
    restoreTimestamp({
      owner: collection,
      key: "modifiedAt",
      path: `${collectionPath}.modifiedAt`
    });
    const documentIds = new Set<number>();
    let maximumDocumentId = 0;
    for (let documentIndex = 0; documentIndex < collection.data.length; documentIndex += 1) {
      const document = collection.data[documentIndex];
      const documentPath = `${collectionPath}.data[${documentIndex}]`;
      assertPlainObject(document, documentPath);
      if (!Number.isSafeInteger(document.$id) || document.$id <= 0) {
        throw new TypeError(`Invalid IluDB document id at ${documentPath}.$id: expected a positive safe integer.`);
      }
      if (documentIds.has(document.$id)) {
        throw new TypeError(`Duplicate IluDB document id at ${documentPath}.$id.`);
      }
      documentIds.add(document.$id);
      if (document.$id > maximumDocumentId) {
        maximumDocumentId = document.$id;
      }
      restoreTimestamp({
        owner: document,
        key: "$createdAt",
        path: `${documentPath}.$createdAt`
      });
      restoreTimestamp({
        owner: document,
        key: "$modifiedAt",
        path: `${documentPath}.$modifiedAt`
      });
    }
    if (collection.index < maximumDocumentId) {
      throw new TypeError(
        `Invalid IluDB index at ${collectionPath}.index: expected a value greater than or equal to the maximum document id.`
      );
    }
  }
  return data;
}

function readStableSnapshot(file: string): StableSnapshot {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pathStats = lstatSync(file);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new TypeError(`IluDB path must be a regular file: ${file}`);
    }
    const descriptor = openSync(file, "r");
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile()) {
        throw new TypeError(`IluDB path must be a regular file: ${file}`);
      }
      const serialized = readFileSync(descriptor, "utf8");
      const after = fstatSync(descriptor);
      if (signature(before) !== signature(after)) {
        continue;
      }
      return {
        data: validateAndRestore(JSON.parse(serialized)),
        signature: signature(after)
      };
    } finally {
      closeSync(descriptor);
    }
  }
  throw new Error(`IluDB file changed repeatedly while it was read: ${file}`);
}

function directoryOf(file: string): string {
  const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  if (separator < 0) {
    return ".";
  }
  const directory = file.slice(0, separator);
  if (directory.length === 0) {
    return file[0];
  }
  return /^[A-Za-z]:$/.test(directory) ? directory + file[separator] : directory;
}

function signature(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function atomicWrite({
  file,
  serialized,
  mode
}: {
  file: string;
  serialized: string;
  mode: number | null;
}): string | null {
  temporaryCounter += 1;
  const temporary = `${file}.tmp-${process.pid}-${temporaryCounter}`;
  let descriptor: number | null = null;
  let temporaryCreated = false;
  let renamed = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    const bytes = Buffer.from(serialized);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("IluDB temporary write made no progress.");
      }
      offset += written;
    }
    if (mode !== null) {
      fchmodSync(descriptor, mode);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    renamed = true;
    try {
      return signature(lstatSync(file));
    } catch {
      return null;
    }
  } catch (error) {
    let primary = error;
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        primary = new AggregateError([primary, closeError]);
      }
    }
    if (!renamed && temporaryCreated) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError: any) {
        if (cleanupError?.code !== "ENOENT") {
          throw new AggregateError([primary, cleanupError], "", {
            cause: cleanupError
          });
        }
      }
    }
    throw primary;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function nodeJSONPlugin(IluDB: IluDBPluginTarget): void {
  IluDB.getDatabase = function (file: string): any {
    if (typeof file !== "string" || file.length === 0) {
      throw new TypeError("IluDB file path must be a non-empty string.");
    }
    const now = new Date();
    const database = {
      dir: file,
      data: {
        collections: {},
        createdAt: now,
        modifiedAt: now,
        revision: 0
      }
    } as NodeJSONDatabase;
    let loadedRevision = 0;
    let loadedPath = file;
    let ownPublication: { revision: number; signature: string } | null = null;
    let watchState: WatchState = "stopped";
    let watchPath: string | null = null;
    let watchListener: ((current: Stats, previous: Stats) => void) | null = null;
    let watchOptions: WatchOptions = {};
    let baselineSignature: string | null = null;
    let failedSignature: string | null = null;
    let pendingSignature: string | null = null;

    database.getCollection = function (name: string): any {
      return IluDB.getCollection(database, name);
    };

    database.reload = function (): void {
      const path = database.dir;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshot = readStableSnapshot(path);
        const staged = IluDB._stageData(database, snapshot.data);
        const pathStats = lstatSync(path);
        if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
          throw new TypeError(`IluDB path must be a regular file: ${path}`);
        }
        if (signature(pathStats) !== snapshot.signature) {
          continue;
        }
        IluDB._publishData(database, staged);
        loadedRevision = snapshot.data.revision;
        loadedPath = path;
        baselineSignature = snapshot.signature;
        ownPublication = null;
        return;
      }
      throw new Error(`IluDB file changed repeatedly while reload was staged: ${path}`);
    };

    database.save = function (): void {
      const path = database.dir;
      let mode: number | null = null;
      try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new TypeError(`IluDB path must be a regular file: ${path}`);
        }
        mode = stats.mode & 0o7777;
        const disk = validateAndRestore(JSON.parse(readFileSync(path, "utf8")));
        if (disk.revision !== loadedRevision) {
          throw new ConflictError(loadedRevision, disk.revision);
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        if (path === loadedPath) {
          throw new ConflictError(loadedRevision, null);
        }
        mkdirSync(directoryOf(path), { recursive: true });
      }

      const modifiedAt = new Date();
      const revision = loadedRevision + 1;
      const snapshot = {
        ...database.data,
        modifiedAt,
        revision
      };
      const serialized = JSON.stringify(snapshot);
      if (typeof serialized !== "string") {
        throw new TypeError("IluDB data could not be serialized.");
      }
      validateAndRestore(JSON.parse(serialized));
      const publishedSignature = atomicWrite({
        file: path,
        serialized,
        mode
      });
      database.data.modifiedAt = modifiedAt;
      database.data.revision = revision;
      loadedRevision = revision;
      loadedPath = path;
      baselineSignature = publishedSignature;
      ownPublication = publishedSignature === null ? null : { revision, signature: publishedSignature };
    };

    database.unwatch = function (): void {
      if (watchListener !== null && watchPath !== null) {
        unwatchFile(watchPath, watchListener);
      }
      watchState = "stopped";
      watchPath = null;
      watchListener = null;
      pendingSignature = null;
    };

    database.watch = function (options: WatchOptions = {}): void {
      if (watchState !== "stopped") {
        return;
      }
      if (!isPlainObject(options)) {
        throw new TypeError("Watch options must be an object.");
      }
      const interval = options.interval ?? 500;
      if (!Number.isSafeInteger(interval) || interval <= 0) {
        throw new TypeError("Watch interval must be a positive integer.");
      }
      if (typeof options.onReload !== "undefined" && typeof options.onReload !== "function") {
        throw new TypeError("onReload must be a function.");
      }
      if (typeof options.onError !== "undefined" && typeof options.onError !== "function") {
        throw new TypeError("onError must be a function.");
      }
      watchOptions = options;
      watchPath = database.dir;
      baselineSignature = signature(lstatSync(watchPath));
      watchState = "idle";

      const reportError = (error: unknown): void => {
        if (typeof watchOptions.onError === "function") {
          try {
            watchOptions.onError(toError(error));
          } catch {
            // Error callbacks cannot interrupt the watcher.
          }
        }
      };

      const processChange = (nextSignature: string): void => {
        if (watchState === "stopped") {
          return;
        }
        if (watchState === "processing" || watchState === "pending") {
          watchState = "pending";
          pendingSignature = nextSignature;
          return;
        }
        if ((nextSignature === baselineSignature && ownPublication === null) || nextSignature === failedSignature) {
          return;
        }
        watchState = "processing";
        let reloaded = false;
        let processingError: unknown = null;
        try {
          if (ownPublication !== null && ownPublication.signature === nextSignature) {
            const snapshot = readStableSnapshot(watchPath!);
            if (snapshot.signature === nextSignature && snapshot.data.revision === ownPublication.revision) {
              baselineSignature = snapshot.signature;
              ownPublication = null;
            } else {
              database.reload();
              reloaded = true;
            }
          } else {
            database.reload();
            reloaded = true;
          }
          failedSignature = null;
        } catch (error) {
          failedSignature = nextSignature;
          processingError = error;
        }
        const queued = pendingSignature;
        pendingSignature = null;
        watchState = "idle";
        if (processingError !== null) {
          reportError(processingError);
        }
        if (reloaded && typeof watchOptions.onReload === "function") {
          try {
            watchOptions.onReload(database);
          } catch (error) {
            reportError(error);
          }
        }
        if (watchListener !== null && queued !== null) {
          processChange(queued);
        }
      };

      watchListener = (current): void => {
        processChange(signature(current));
      };
      watchFile(watchPath, { interval, persistent: false }, watchListener);
    };

    try {
      database.reload();
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      mkdirSync(directoryOf(file), { recursive: true });
      const serialized = JSON.stringify(database.data);
      baselineSignature = atomicWrite({
        file,
        serialized,
        mode: null
      });
      const staged = IluDB._stageData(database, database.data);
      IluDB._publishData(database, staged);
    }
    IluDB.plugify(database);
    return database;
  };
}

nodeJSONPlugin.ConflictError = ConflictError;

export default nodeJSONPlugin;
