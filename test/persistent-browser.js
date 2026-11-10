// Browser-only integration cases. Every Storage operation uses the browser's
// real implementation. No global, filesystem, event, or adapter is mocked.
const cases = new Map();
const databases = [];
const keys = [];
const frames = [];
const prefix = `iludb-test:${crypto.randomUUID()}:`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function rejects(action) {
  let rejected = false;
  try {
    action();
  } catch {
    rejected = true;
  }
  assert(rejected, "Operation must reject");
}

async function documentWindow({ opaque = false, coreOnly = false } = {}) {
  const frame = document.createElement("iframe");
  frames.push(frame);
  frame.hidden = true;
  if (opaque) {
    frame.sandbox = "allow-scripts";
  }
  const token = crypto.randomUUID();
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Browser document did not load"));
    }, 5000);
    const listener = (event) => {
      if (event.source === frame.contentWindow && event.data?.token === token) {
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        resolve(event.data);
      }
    };
    window.addEventListener("message", listener);
  });
  frame.srcdoc = `<script src="${location.origin}/core.js"></script>
    ${coreOnly ? "" : `<script src="${location.origin}/adapter.js"></script>`}
    <script>
    ${
      opaque
        ? `
      let denied = false;
      try { localStorage.getItem("unused"); } catch { denied = true; }
      let coreWorks = false;
      try {
        const records = IluDB().getCollection("records");
        const saved = records.add({value: "memory"});
        coreWorks = records.get(saved.$id).value === "memory";
      } catch {}
      let adapterRejects = true;
      const adapterLoaded = typeof IluDBLocalStorageAdapter === "object" || typeof IluDBLocalStorageAdapter === "function";
      ${
        coreOnly
          ? ""
          : `try {
        IluDB({adapter: IluDBLocalStorageAdapter}).load("denied");
        adapterRejects = false;
      } catch {}`
      }
      parent.postMessage({token: ${JSON.stringify(token)}, denied, coreWorks, adapterRejects, adapterLoaded}, "*");
    `
        : `parent.postMessage({token: ${JSON.stringify(token)}}, "*");`
    }
    </script>`;
  document.body.append(frame);
  const result = await ready;
  return { frame, window: frame.contentWindow, result };
}

function open({ realm = window, key = `${prefix}${keys.length}` } = {}) {
  keys.push(key);
  const database =
    realm === window
      ? window.IluDB({ adapter: window.IluDBLocalStorageAdapter })
      : realm.eval("IluDB({ adapter: IluDBLocalStorageAdapter })");
  databases.push(database);
  database.load(key);
  return { database, key, records: database.getCollection("records") };
}

async function eventually(check) {
  const deadline = performance.now() + 4000;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error("Expected browser state did not arrive");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

cases.set("invalid-and-recovery", () => {
  const { database, records, key } = open();
  const saved = records.add({ value: "retained", body: "retained token" });
  records.createIndex("by-value", "value");
  records.createTextIndex("content", "body");
  const bytes = localStorage.getItem(key);
  const revision = database.snapshot().revision;
  for (const invalid of [null, [], 42, { $id: 1 }, { invalidJSON: 1n }]) {
    rejects(() => records.add(invalid));
    assert(records.count() === 1, "Rejected add changed memory");
    assert(localStorage.getItem(key) === bytes, "Rejected add changed storage");
    assert(database.snapshot().revision === revision, "Rejected add advanced revision");
  }
  for (const contents of ["not JSON", "[]", JSON.stringify({ ...JSON.parse(bytes), revision: -1 })]) {
    localStorage.setItem(key, contents);
    rejects(() => database.reload());
    assert(records.findOne({ value: "retained" }).$id === saved.$id, "Invalid reload changed exact query");
    assert(records.searchText("content", "retained").length === 1, "Invalid reload changed text query");
  }
  localStorage.setItem(key, bytes);
  database.reload();
  records.update({ $id: saved.$id, value: "recovered" });
  assert(records.count({ value: "recovered" }) === 1, "Valid operation did not recover");
});

cases.set("collection-plugins", () => {
  const { database, records, key } = open();
  const initialize = (target) => {
    const count = target.count();
    target.add({ value: "initialized", previous: count });
    target.total = () => target.count();
  };
  records.use(initialize);
  records.use(initialize);
  assert(records.total() === 1, "Repeated plugin registration repeated initialization");
  const reopened = open({ key });
  assert(reopened.records.count({ value: "initialized" }) === 1, "Plugin initialization did not persist once");
  database.transaction((tx) => {
    const staged = tx.getCollection("records");
    staged.use(initialize);
    staged.use(initialize);
    assert(staged.total() === 2, "Transaction plugin did not initialize once");
  });
  assert(records.total() === 2, "Transaction plugin changes did not publish");
});

cases.set("transaction-isolation", () => {
  const { database, records, key } = open();
  records.add({ value: "retained" });
  const bytes = localStorage.getItem(key);
  for (const completion of ["throw", "thenable", "reentry", "plugin-reentry"]) {
    rejects(() =>
      database.transaction((tx) => {
        tx.getCollection("records").add({ value: "unpublished" });
        assert(localStorage.getItem(key) === bytes, "Stage leaked to storage");
        if (completion === "throw") {
          throw new Error("Synthetic callback failure");
        }
        if (completion === "reentry") {
          records.add({ value: "external reentry" });
          return;
        }
        if (completion === "plugin-reentry") {
          records.use((target) => target.add({ value: "external plugin" }));
          return;
        }
        return { then() {} };
      })
    );
    assert(records.count() === 1, "Rejected transaction changed memory");
    assert(localStorage.getItem(key) === bytes, "Rejected transaction changed storage");
  }
  let escaped;
  const returned = database.transaction((tx) => {
    escaped = tx.getCollection("records");
    return escaped.add({ value: "committed", nested: { retained: true } });
  });
  rejects(() => escaped.add({ value: "expired" }));
  returned.nested.retained = false;
  assert(records.get(returned.$id).nested.retained, "Transaction result leaked mutable state");
});

cases.set("initial-load-and-legacy", () => {
  const key = `${prefix}recoverable-load`;
  keys.push(key);
  localStorage.setItem(key, "not JSON");
  const database = window.IluDB({ adapter: window.IluDBLocalStorageAdapter });
  databases.push(database);
  rejects(() => database.load(key));
  assert(localStorage.getItem(key) === "not JSON", "Failed load overwrote storage");
  const source = open();
  const saved = source.records.add({ value: "portable" });
  const legacy = JSON.parse(localStorage.getItem(source.key));
  delete legacy.revision;
  localStorage.setItem(key, JSON.stringify(legacy));
  database.load(key);
  assert(database.snapshot().revision === 0, "Legacy revision did not start at zero");
  assert(database.getCollection("records").get(saved.$id).value === "portable", "Recovered load lost documents");
  const other = `${prefix}not-retargeted`;
  keys.push(other);
  localStorage.setItem(other, "untouched");
  rejects(() => database.load(other));
  database.save();
  assert(JSON.parse(localStorage.getItem(key)).revision === 1, "Legacy save did not advance revision");
  assert(localStorage.getItem(other) === "untouched", "Load retargeted storage");
});

cases.set("watch-defers-during-transaction", async () => {
  const reader = open();
  reader.records.add({ value: "retained" });
  const writer = open({ key: reader.key });
  reader.database.watch();
  const before = reader.database.snapshot().revision;
  rejects(() =>
    reader.database.transaction((tx) => {
      tx.getCollection("records").add({ value: "must roll back" });
      writer.records.add({ value: "external during transaction" });
      assert(reader.database.snapshot().revision === before, "Notification replaced protected snapshot");
      assert(tx.getCollection("records").count() === 2, "Notification replaced transaction stage");
      // The commit must now conflict with the real write from the other session.
    })
  );
  await eventually(() => reader.records.count({ value: "external during transaction" }) === 1);
  assert(reader.records.count({ value: "must roll back" }) === 0, "Conflicting transaction leaked a document");
});

cases.set("quota-rollback", () => {
  const { database, records, key } = open();
  const saved = records.add({ value: "retained", body: "retained token" });
  records.createIndex("by-value", "value");
  records.createTextIndex("content", "body");
  const bytes = localStorage.getItem(key);
  const revision = database.snapshot().revision;
  // Chromium's real localStorage quota is smaller than this synthetic value.
  // Failure to reach that boundary fails the case instead of faking quota.
  rejects(() => records.update({ $id: saved.$id, value: "unpublished", payload: "x".repeat(32 * 1024 * 1024) }));
  assert(localStorage.getItem(key) === bytes, "Quota failure replaced stored data");
  assert(database.snapshot().revision === revision, "Quota failure advanced revision");
  assert(records.count({ value: "retained" }) === 1, "Quota failure changed indexed memory");
  assert(records.searchText("content", "retained").length === 1, "Quota failure changed text index");
  records.update({ $id: saved.$id, value: "recovered" });
  assert(records.count({ value: "recovered" }) === 1, "Write after quota rejection failed");
});

cases.set("same-document-policy", async () => {
  const first = open();
  const second = open({ key: first.key });
  const unrelated = `${prefix}unrelated`;
  keys.push(unrelated);
  localStorage.setItem(unrelated, "retain this value");
  let ownReloads = 0;
  first.database.watch({
    onReload() {
      ownReloads += 1;
    }
  });
  second.database.watch();
  const saved = first.records.add({ value: "shared", body: "shared token" });
  await eventually(() => second.records.count({ value: "shared" }) === 1);
  assert(ownReloads === 0, "Own save triggered reload notification");
  assert(localStorage.getItem(unrelated) === "retain this value", "Adapter changed another key");
  const external = JSON.parse(localStorage.getItem(first.key));
  external.revision += 1;
  external.collections.records.data[0].value = "direct storage write";
  localStorage.setItem(first.key, JSON.stringify(external));
  assert(first.records.get(saved.$id).value === "shared", "Direct same-document write reloaded implicitly");
  first.database.reload();
  assert(first.records.get(saved.$id).value === "direct storage write", "Explicit reload did not load direct write");
  rejects(() => second.records.add({ value: "stale" }));
  assert(second.records.count() === 1, "Conflict changed stale memory");
  second.database.reload();
  second.database.unwatch();
  second.database.unwatch();
  first.database.close();
  first.database.close();
  rejects(() => first.records.add({ value: "closed" }));
});

cases.set("cross-document-watch", async () => {
  const reader = open();
  reader.records.add({ value: "initial", body: "initial token" });
  reader.records.createIndex("by-value", "value");
  reader.records.createTextIndex("content", "body");
  const peer = await documentWindow();
  const writer = open({ realm: peer.window, key: reader.key });
  reader.database.watch();
  writer.records.add(peer.window.JSON.parse(JSON.stringify({ value: "external", body: "external token" })));
  await eventually(() => reader.records.count({ value: "external" }) === 1);
  assert(reader.records.searchText("content", "external").length === 1, "Storage event did not rebuild text index");
  const bytes = peer.window.localStorage.getItem(reader.key);
  // A real storage event after each invalid write is an event-loop barrier.
  for (const invalid of ["not JSON", null]) {
    const delivered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("storage", listener);
        reject(new Error("Real storage event was not delivered"));
      }, 4000);
      function listener(event) {
        if (event.key === reader.key) {
          clearTimeout(timeout);
          window.removeEventListener("storage", listener);
          setTimeout(resolve, 0);
        }
      }
      window.addEventListener("storage", listener);
    });
    if (invalid === null) {
      peer.window.localStorage.removeItem(reader.key);
    } else {
      peer.window.localStorage.setItem(reader.key, invalid);
    }
    await delivered;
    assert(reader.records.count({ value: "external" }) === 1, "Invalid/deleted storage replaced active state");
  }
  peer.window.localStorage.setItem(reader.key, bytes);
  reader.database.unwatch();
  const restored = JSON.parse(bytes);
  restored.revision += 1;
  restored.collections.records.data[0].value = "after cancellation";
  peer.window.localStorage.setItem(reader.key, JSON.stringify(restored));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(reader.records.count({ value: "initial" }) === 1, "Cancelled watcher still reloaded");
});

cases.set("crud-and-reopen", () => {
  const { database, records, key } = open();
  records.createIndex("by-state", "state");
  records.createTextIndex("content", "body");
  const input = { state: "open", score: 2, body: "Café azul", nested: { retained: true }, date: new Date(0) };
  const saved = records.add(input);
  input.nested.retained = false;
  saved.nested.retained = false;
  records.add({ state: "open", score: 1, body: "cafe verde" });
  assert(records.find({}, { sort: { score: 1 } })[0].score === 1, "Sort changed order");
  assert(records.searchText("content", "CAFE azul")[0].$id === saved.$id, "Normalized text query failed");
  assert(records.get(saved.$id).nested.retained, "Input or result mutated stored document");
  const snapshot = database.snapshot();
  snapshot.collections.records.data[0].state = "tampered";
  assert(records.get(saved.$id).state === "open", "Snapshot mutated memory");
  const reopened = open({ key });
  const restored = reopened.records.get(saved.$id);
  assert(restored.$createdAt.getTime() === saved.$createdAt.getTime(), "Metadata date changed on reopen");
  assert(restored.date === new Date(0).toISOString(), "User date lost JSON semantics");
  const updated = records.update({ $id: saved.$id, state: "done", body: "final token" });
  assert(updated.$createdAt.getTime() === saved.$createdAt.getTime(), "Update changed creation date");
  assert(records.searchText("content", "azul").length === 0, "Update left obsolete text posting");
  records.remove(updated);
  assert(records.get(saved.$id) === null, "Removed document still exists");
  assert(records.findOne({ state: "done" }) === null, "Absent query did not return null");
  assert(records.searchText("content", "final").length === 0, "Remove left text posting");
});

cases.set("denied-storage-and-memory-core", async () => {
  const { result } = await documentWindow({ opaque: true });
  assert(result.denied, "Sandbox did not deny real storage access");
  assert(result.adapterLoaded, "Adapter script did not load in sandbox");
  assert(result.adapterRejects, "Persistent load accepted denied storage");
  assert(result.coreWorks, "Memory core failed where storage access is denied");
});

window.runPersistenceCase = async (name) => {
  const action = cases.get(name);
  assert(typeof action === "function", "Unknown browser persistence case");
  try {
    await action();
  } finally {
    for (const database of databases) {
      database.close();
    }
    for (const key of new Set(keys)) {
      localStorage.removeItem(key);
    }
    for (const frame of frames) {
      frame.remove();
    }
  }
};
