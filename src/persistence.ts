export type ErrorCode = "INVALID_INPUT" | "INVALID_SNAPSHOT" | "CONFLICT" | "IO" | "CLOSED" | "BUSY";

export class PersistenceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

export class ConflictError extends PersistenceError {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number | null
  ) {
    super("CONFLICT", "The persisted snapshot revision changed.");
  }
}

export interface WriteSnapshot {
  serialized: string;
  expectedRevision: number | null;
}

export interface Adapter {
  read(): string | null;
  write(input: WriteSnapshot): void;
  subscribe(onChange: () => void, options: { interval: number }): () => void;
}

export interface AsyncAdapter extends Adapter {
  asyncRead(): Promise<string | null>;
  asyncWrite(input: WriteSnapshot): Promise<void>;
}

export interface AdapterFactory {
  open(destination: string): Adapter;
}

function plain(value: any): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

export function restore(serialized: string): any {
  try {
    const data = JSON.parse(serialized);
    if (!plain(data) || !plain(data.collections)) {
      throw new Error("Invalid database");
    }
    if (!Object.hasOwn(data, "revision")) {
      data.revision = 0;
    }
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) {
      throw new Error("Invalid revision");
    }
    const timestamp = (owner: any, key: string): void => {
      const value = owner[key];
      if (typeof value !== "string") {
        throw new Error("Invalid timestamp");
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
        throw new Error("Invalid timestamp");
      }
      owner[key] = date;
    };
    timestamp(data, "createdAt");
    timestamp(data, "modifiedAt");
    for (const [name, collection] of Object.entries<any>(data.collections)) {
      assertCollectionName(name);
      if (
        !plain(collection) ||
        !Array.isArray(collection.data) ||
        !Number.isSafeInteger(collection.index) ||
        collection.index < 0
      ) {
        throw new Error("Invalid collection");
      }
      timestamp(collection, "createdAt");
      timestamp(collection, "modifiedAt");
      const ids = new Set<number>();
      for (const document of collection.data) {
        if (
          !plain(document) ||
          !Number.isSafeInteger(document.$id) ||
          document.$id <= 0 ||
          document.$id > collection.index ||
          ids.has(document.$id)
        ) {
          throw new Error("Invalid document");
        }
        ids.add(document.$id);
        timestamp(document, "$createdAt");
        timestamp(document, "$modifiedAt");
      }
    }
    return data;
  } catch (cause) {
    throw new PersistenceError("INVALID_SNAPSHOT", "Invalid IluDB snapshot.", { cause });
  }
}

export function checkRevision(input: { serialized: string | null; expectedRevision: number | null }): void {
  const actual = typeof input.serialized === "string" ? restore(input.serialized).revision : null;
  if (actual !== input.expectedRevision) {
    throw new ConflictError(input.expectedRevision ?? 0, actual);
  }
}

function assertCollectionName(name: string): void {
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.trim() !== name ||
    ["__proto__", "constructor", "prototype"].includes(name)
  ) {
    throw new PersistenceError("INVALID_INPUT", "Invalid collection name.");
  }
}

export function createPersistentDatabase(input: { core: any; factory: AdapterFactory; asynchronous: boolean }): any {
  const { core: IluDB, factory, asynchronous } = input;
  let active: any = null;
  let storage: any = null;
  let loading = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  let pending = 0;
  let protectedState = false;
  let queue: Promise<unknown> = Promise.resolve();
  let stopWatching: (() => void) | null = null;
  let watchPending = false;
  let watchOptions: any = {};
  let baseline: string | null = null;

  function available(requireLoaded = true): void {
    if (closed) {
      throw new PersistenceError("CLOSED", "Database is closed.");
    }
    if (protectedState || pending > 0 || loading) {
      throw new PersistenceError("BUSY", "Database has an operation in progress.");
    }
    if (requireLoaded && active === null) {
      throw new PersistenceError("INVALID_INPUT", "Load a database first.");
    }
  }

  function stage(snapshot: any, previous = active): any {
    const next: any = { data: snapshot, save() {} };
    next.getCollection = (name: string): any => {
      assertCollectionName(name);
      return IluDB.getCollection(next, name);
    };
    if (previous !== null) {
      for (const name of Object.keys(snapshot.collections)) {
        if (!Object.hasOwn(previous.data.collections, name)) {
          continue;
        }
        const source = previous.getCollection(name);
        const target = next.getCollection(name);
        for (const index of source.getIndexes()) {
          target.createIndex(index.name, index.fields);
        }
        for (const index of source.getTextIndexes()) {
          target.createTextIndex(index.name, index.fields);
        }
      }
    }
    return next;
  }

  function prepare(mutate: (tx: any) => any): { publication: any; serialized: string; result: any } {
    if (typeof mutate !== "function") {
      throw new PersistenceError("INVALID_INPUT", "Invalid transaction callback.");
    }
    const next = stage(structuredClone(active.data));
    let live = true;
    const tx = {
      getCollection(name: string): any {
        if (!live) {
          throw new PersistenceError("CLOSED", "Transaction is inactive.");
        }
        return wrap({
          resolve: () => next.getCollection(name),
          admit: () => {
            if (!live) {
              throw new PersistenceError("CLOSED", "Transaction is inactive.");
            }
          },
          transaction: true
        });
      }
    };
    let result: any;
    try {
      result = mutate(tx);
      if (result !== null && ["object", "function"].includes(typeof result) && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new PersistenceError("INVALID_INPUT", "Transaction callbacks must be synchronous.");
      }
      result = structuredClone(result);
    } finally {
      live = false;
    }
    if (active.data.revision === Number.MAX_SAFE_INTEGER) {
      throw new PersistenceError("INVALID_INPUT", "Revision exhausted.");
    }
    next.data.revision = active.data.revision + 1;
    next.data.modifiedAt = new Date();
    const serialized = JSON.stringify(next.data);
    return { publication: stage(restore(serialized), next), serialized, result };
  }

  function finishWatch(): void {
    if (watchPending && stopWatching !== null && !protectedState && !closed) {
      watchPending = false;
      changed();
    }
  }

  function sync<T>(operation: () => T, requireLoaded = true): T {
    available(requireLoaded);
    protectedState = true;
    try {
      return operation();
    } finally {
      protectedState = false;
      finishWatch();
    }
  }

  function enqueue<T>(operation: () => T | Promise<T>, requireLoaded = true): Promise<T> {
    try {
      if (closed || protectedState || loading || (requireLoaded && active === null)) {
        throw new PersistenceError(closed ? "CLOSED" : "BUSY", "Database cannot admit this operation.");
      }
      pending += 1;
      const result = queue.then(async () => {
        try {
          return await operation();
        } finally {
          pending -= 1;
        }
      });
      queue = result.catch(() => {});
      return result;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  function transaction(mutate: (tx: any) => any): any {
    const prepared = prepare(mutate);
    storage.write({ serialized: prepared.serialized, expectedRevision: active.data.revision });
    active = prepared.publication;
    baseline = prepared.serialized;
    return prepared.result;
  }

  async function asyncTransaction(mutate: (tx: any) => any): Promise<any> {
    protectedState = true;
    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare(mutate);
    } finally {
      protectedState = false;
    }
    await storage.asyncWrite({ serialized: prepared.serialized, expectedRevision: active.data.revision });
    active = prepared.publication;
    baseline = prepared.serialized;
    return prepared.result;
  }

  const mutations = new Set(["add", "update", "remove"]);
  const methods = [
    "add",
    "update",
    "remove",
    "get",
    "find",
    "findOne",
    "count",
    "sort",
    "createIndex",
    "getIndexes",
    "dropIndex",
    "createTextIndex",
    "getTextIndexes",
    "dropTextIndex",
    "searchText",
    "reindex",
    "use"
  ];

  function wrap(options: {
    resolve: () => any;
    admit: () => void;
    transaction?: boolean;
    asynchronous?: boolean;
    name?: string;
  }): any {
    const handle: any = {};
    const plugins = new Set<(...args: any[]) => void>();
    for (const method of methods) {
      handle[method] = (...args: any[]): any => {
        const execute = (captured: any[]): any => {
          const source = options.resolve();
          if (method === "use") {
            if (typeof captured[0] !== "function") {
              throw new PersistenceError("INVALID_INPUT", "Invalid collection plugin.");
            }
            const plugin = captured[0];
            if (!plugins.has(plugin)) {
              plugin(handle, ...captured.slice(1));
              plugins.add(plugin);
            }
            return handle;
          }
          let value: any;
          try {
            value = source[method](...captured);
          } catch (cause) {
            throw new PersistenceError("INVALID_INPUT", "Invalid collection operation.", { cause });
          }
          if (method === "add" && !plain(value)) {
            throw new PersistenceError("INVALID_INPUT", "Invalid document.");
          }
          return value === source ? handle : ["get", "findOne"].includes(method) ? (value ?? null) : value;
        };
        if (options.transaction) {
          options.admit();
          return execute(method === "use" ? args : structuredClone(args));
        }
        if (options.asynchronous) {
          try {
            if (closed || protectedState) {
              throw new PersistenceError(closed ? "CLOSED" : "BUSY", "Operation cannot be admitted.");
            }
            const captured = method === "use" ? [args[0], ...structuredClone(args.slice(1))] : structuredClone(args);
            return enqueue(() => {
              options.resolve();
              return mutations.has(method)
                ? asyncTransaction((tx) => tx.getCollection(options.name)[method](...captured))
                : execute(captured);
            });
          } catch (cause) {
            return Promise.reject(
              cause instanceof PersistenceError
                ? cause
                : new PersistenceError("INVALID_INPUT", "Invalid operation input.", { cause })
            );
          }
        }
        if (method === "use") {
          available();
          return execute(args);
        }
        return sync(() => {
          options.resolve();
          return mutations.has(method)
            ? transaction((tx) => tx.getCollection(options.name)[method](...args))
            : execute(method === "use" ? args : structuredClone(args));
        });
      };
    }
    return handle;
  }

  function initial(destination: string): any {
    if (active !== null) {
      throw new PersistenceError("INVALID_INPUT", "Database is already loaded.");
    }
    if (typeof destination !== "string" || destination.trim().length === 0 || destination.includes("\0")) {
      throw new PersistenceError("INVALID_INPUT", "Invalid storage destination.");
    }
    return factory.open(destination);
  }

  function loadSnapshot(serialized: string | null): any {
    if (typeof serialized === "string") {
      return stage(restore(serialized));
    }
    const now = new Date();
    return stage({ collections: {}, createdAt: now, modifiedAt: now, revision: 0 });
  }

  function reload(serialized: string | null): void {
    if (typeof serialized !== "string") {
      throw new PersistenceError("IO", "Storage destination disappeared.");
    }
    const next = stage(restore(serialized));
    active = next;
    baseline = serialized;
  }

  function changed(): void {
    if (stopWatching === null || closed) {
      return;
    }
    if (protectedState) {
      watchPending = true;
      return;
    }
    const notify = (serialized: string | null): void => {
      if (stopWatching === null || closed || serialized === baseline) {
        return;
      }
      reload(serialized);
      watchOptions.onReload?.(database);
    };
    const report = (error: unknown): void => {
      try {
        watchOptions.onError?.(error);
      } catch {
        /* A callback must not break storage notifications. */
      }
    };
    if (asynchronous) {
      void enqueue(async () => notify(await storage.asyncRead())).catch(report);
    } else {
      try {
        sync(() => notify(storage.read()));
      } catch (error) {
        report(error);
      }
    }
  }

  const database: any = {
    load(destination: string): void {
      sync(() => {
        const session = initial(destination);
        const serialized = session.read();
        const next = loadSnapshot(serialized);
        if (serialized === null) {
          session.write({ serialized: JSON.stringify(next.data), expectedRevision: null });
        }
        storage = session;
        active = next;
        baseline = serialized ?? JSON.stringify(next.data);
      }, false);
    },
    getCollection(name: string): any {
      available();
      assertCollectionName(name);
      active.getCollection(name);
      return wrap({
        resolve: () => {
          if (!Object.hasOwn(active.data.collections, name)) {
            throw new PersistenceError("INVALID_INPUT", "The collection is inactive after reload.");
          }
          return active.getCollection(name);
        },
        admit: () => available(),
        name
      });
    },
    transaction(mutate: (tx: any) => any): any {
      return sync(() => transaction(mutate));
    },
    save(): void {
      sync(() => transaction(() => {}));
    },
    reload(): void {
      sync(() => reload(storage.read()));
    },
    snapshot(): any {
      // A protected callback may inspect the committed snapshot, never its mutable stage.
      if (protectedState && active !== null && !closed) {
        return structuredClone(active.data);
      }
      return sync(() => structuredClone(active.data));
    },
    watch(options: any = {}): void {
      available();
      if (stopWatching !== null) {
        return;
      }
      if (
        !plain(options) ||
        !Number.isSafeInteger(options.interval ?? 500) ||
        (options.interval ?? 500) <= 0 ||
        (Object.hasOwn(options, "onReload") && typeof options.onReload !== "function") ||
        (Object.hasOwn(options, "onError") && typeof options.onError !== "function")
      ) {
        throw new PersistenceError("INVALID_INPUT", "Invalid watch options.");
      }
      watchOptions = { ...options };
      stopWatching = storage.subscribe(changed, { interval: options.interval ?? 500 });
    },
    unwatch(): void {
      if (protectedState) {
        throw new PersistenceError("BUSY", "Operation in progress.");
      }
      stopWatching?.();
      stopWatching = null;
      watchPending = false;
    },
    close(): void {
      if (closed) {
        return;
      }
      available(false);
      database.unwatch();
      closed = true;
    }
  };

  if (asynchronous) {
    Object.assign(database, {
      asyncLoad(destination: string): Promise<void> {
        if (loading || pending > 0) {
          return Promise.reject(new PersistenceError("BUSY", "Load in progress."));
        }
        const operation = enqueue(async () => {
          try {
            const session: any = initial(destination);
            const serialized = await session.asyncRead();
            const next = loadSnapshot(serialized);
            if (serialized === null) {
              await session.asyncWrite({ serialized: JSON.stringify(next.data), expectedRevision: null });
            }
            storage = session;
            active = next;
            baseline = serialized ?? JSON.stringify(next.data);
          } finally {
            loading = false;
          }
        }, false);
        loading = true;
        return operation;
      },
      getAsyncCollection(name: string): any {
        if (closed || protectedState || active === null) {
          throw new PersistenceError(closed ? "CLOSED" : "BUSY", "Database unavailable.");
        }
        assertCollectionName(name);
        if (pending === 0) {
          active.getCollection(name);
        }
        let acquired = Object.hasOwn(active.data.collections, name);
        return wrap({
          resolve: () => {
            if (acquired && !Object.hasOwn(active.data.collections, name)) {
              throw new PersistenceError("INVALID_INPUT", "The collection is inactive after reload.");
            }
            acquired = true;
            return active.getCollection(name);
          },
          admit: () => {},
          name,
          asynchronous: true
        });
      },
      asyncTransaction(mutate: (tx: any) => any): Promise<any> {
        return enqueue(() => asyncTransaction(mutate));
      },
      asyncSave(): Promise<void> {
        return enqueue(() => asyncTransaction(() => {}));
      },
      asyncReload(): Promise<void> {
        return enqueue(async () => reload(await storage.asyncRead()));
      },
      asyncSnapshot(): Promise<any> {
        return enqueue(() => structuredClone(active.data));
      },
      asyncClose(): Promise<void> {
        if (protectedState) {
          return Promise.reject(new PersistenceError("BUSY", "Transaction in progress."));
        }
        if (closing !== null) {
          return closing;
        }
        database.unwatch();
        closed = true;
        closing = queue.then(() => {});
        return closing;
      }
    });
  }
  return database;
}
