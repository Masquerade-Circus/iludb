import { beforeEach, describe, expect, it } from "bun:test";
import type IluDbSource from "../src/index";

const IluDb = require("../dist/iludb.js") as typeof IluDbSource;

describe("Database", () => {
  let db: ReturnType<typeof IluDb>;

  beforeEach(() => {
    db = IluDb("test");
  });

  it("Should load a database", () => {
    expect(db).toEqual(
      expect.objectContaining({
        data: {
          collections: {},
          createdAt: expect.any(Date),
          modifiedAt: expect.any(Date)
        },
        getCollection: expect.any(Function),
        save: expect.any(Function),
        use: expect.any(Function)
      })
    );
  });

  it("Should create a collection when first try to get if does not exists", () => {
    expect(db).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ collections: {} })
      })
    );

    db.getCollection("test");

    expect(db).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          collections: {
            test: {
              data: [],
              index: 0,
              createdAt: expect.any(Date),
              modifiedAt: expect.any(Date)
            }
          }
        })
      })
    );
  });

  it("Should test must to have methods of a returned collection", () => {
    const collection = db.getCollection("test");

    expect(collection).toEqual({
      sort: expect.any(Function),
      find: expect.any(Function),
      findOne: expect.any(Function),
      get: expect.any(Function),
      add: expect.any(Function),
      update: expect.any(Function),
      remove: expect.any(Function),
      count: expect.any(Function),
      createIndex: expect.any(Function),
      getIndexes: expect.any(Function),
      dropIndex: expect.any(Function),
      createTextIndex: expect.any(Function),
      getTextIndexes: expect.any(Function),
      dropTextIndex: expect.any(Function),
      searchText: expect.any(Function),
      reindex: expect.any(Function),
      use: expect.any(Function)
    });
  });

  it("Should reject invalid and duplicate index definitions", () => {
    const collection = db.getCollection("test");
    const invalidNames = ["", "   ", 1, null];
    for (let index = 0; index < invalidNames.length; index += 1) {
      expect(() => collection.createIndex(invalidNames[index] as any, "status")).toThrow(TypeError);
    }
    const invalidFields = ["", [], ["status", "status"], ["status", ""]];
    for (let index = 0; index < invalidFields.length; index += 1) {
      expect(() => collection.createIndex("invalid", invalidFields[index] as any)).toThrow(TypeError);
    }

    collection.createIndex("by-status", "status");
    expect(() => collection.createIndex("by-status", "other")).toThrow();
    expect(() => collection.createTextIndex("by-status", "body")).toThrow();
    expect(() => collection.searchText("missing", "word")).toThrow();
    expect(() =>
      collection.searchText("by-status", "word", {
        operator: "XOR"
      } as any)
    ).toThrow(TypeError);
    expect(collection.dropIndex("missing")).toBe(false);
    expect(collection.dropTextIndex("missing")).toBe(false);
  });

  it("Should use late exact indexes without changing query semantics or order", () => {
    const first = db.getCollection("test");
    first.add({ tenant: "a", status: "open", name: "first" });
    first.add({ tenant: "b", status: "open", name: "second" });
    first.add({ tenant: "a", status: "open", name: "third" });
    first.add({ tenant: "a", name: "missing status" });
    first.add({ tenant: "a", status: undefined, name: "undefined status" });
    first.createIndex("by-status", "status");
    first.createIndex("by-tenant-status", ["tenant", "status"]);

    const second = db.getCollection("test");
    expect(second.getIndexes()).toEqual([
      { name: "by-status", fields: ["status"] },
      {
        name: "by-tenant-status",
        fields: ["tenant", "status"]
      }
    ]);
    expect(second.find({ tenant: "a", status: "open", name: "third" })).toEqual([
      expect.objectContaining({ name: "third" })
    ]);
    expect(second.find({ status: "open" })).toEqual([
      expect.objectContaining({ name: "first" }),
      expect.objectContaining({ name: "second" }),
      expect.objectContaining({ name: "third" })
    ]);
    expect(second.findOne({ tenant: "a", status: "open" })!.name).toBe("first");
    expect(second.find({ name: "missing status" })).toHaveLength(1);
    expect(second.find({ status: undefined })).toEqual([expect.objectContaining({ name: "undefined status" })]);
    expect(second.count({ status: undefined })).toBe(1);
    expect(second.count({ name: "missing status", status: undefined })).toBe(0);

    const definitions = second.getIndexes();
    definitions[0].fields[0] = "changed";
    expect(second.getIndexes()[0].fields).toEqual(["status"]);
    expect(second.dropIndex("by-status")).toBe(true);
    expect(first.getIndexes()).toHaveLength(1);
  });

  it("Should keep strict equality for NaN and object references with indexes", () => {
    const scan = db.getCollection("scan");
    const indexed = db.getCollection("indexed");
    const shared = { active: true };

    scan.add({ name: "nan", value: Number.NaN });
    indexed.add({ name: "nan", value: Number.NaN });
    scan.add({ name: "shared", value: shared });
    indexed.add({ name: "shared", value: shared });
    scan.add({ name: "other", value: { active: true } });
    indexed.add({ name: "other", value: { active: true } });
    indexed.createIndex("by-value", "value");

    const scanNaN = scan.find({ value: Number.NaN });
    const indexedNaN = indexed.find({ value: Number.NaN });
    expect(indexedNaN).toHaveLength(scanNaN.length);
    expect(indexedNaN).toHaveLength(0);
    expect(indexed.count({ value: Number.NaN })).toBe(scan.count({ value: Number.NaN }));

    const scanShared = scan.find({ value: shared });
    const indexedShared = indexed.find({ value: shared });
    expect(indexedShared).toHaveLength(scanShared.length);
    expect(indexedShared[0].name).toBe(scanShared[0].name);
    expect(indexed.count({ value: shared })).toBe(scan.count({ value: shared }));
    const equalButDifferent = { active: true };
    const scanDifferent = scan.find({ value: equalButDifferent });
    const indexedDifferent = indexed.find({ value: equalButDifferent });
    expect(indexedDifferent).toHaveLength(scanDifferent.length);
    expect(indexedDifferent).toHaveLength(0);
    expect(indexed.count({ value: equalButDifferent })).toBe(scan.count({ value: equalButDifferent }));
  });

  it("Should synchronize exact indexes through add, update and remove", () => {
    const collection = db.getCollection("test");
    collection.createIndex("by-state", "state");
    collection.createIndex("by-state-kind", ["state", "kind"]);

    const first = collection.add({ state: "new", kind: "a" })!;
    const second = collection.add({ state: "done", kind: "a" })!;
    const third = collection.add({ state: "new", kind: "a" })!;
    collection.update({ ...first, state: "done" });

    expect(collection.find({ state: "new", kind: "a" })).toEqual([expect.objectContaining({ $id: third.$id })]);
    expect(collection.find({ state: "done", kind: "a" })).toEqual([
      expect.objectContaining({ $id: first.$id }),
      expect.objectContaining({ $id: second.$id })
    ]);

    collection.remove(third);
    expect(collection.find({ state: "new" })).toEqual([]);
    expect(collection.findOne({ state: "done" })!.$id).toBe(first.$id);
  });

  it("Should search normalized whole words with AND and OR", () => {
    const collection = db.getCollection("test");
    collection.add({ title: "Café café", body: "Azul intenso" });
    collection.add({ title: "Cafe claro", body: "Verde" });
    collection.add({ title: "Otro", body: "Azul" });
    collection.add({ title: 42, body: null });
    collection.createTextIndex("content", ["title", "body"]);
    collection.add({ title: "Nuevo", body: "Índice rápido" });

    expect(collection.getTextIndexes()).toEqual([{ name: "content", fields: ["title", "body"] }]);
    const result = collection.searchText("content", "CAFE azul");
    expect(result).toEqual([expect.objectContaining({ title: "Café café" })]);
    result[0].title = "changed result";
    expect(
      collection.searchText("content", "verde azul azul", {
        operator: "OR"
      })
    ).toEqual([
      expect.objectContaining({ title: "Café café" }),
      expect.objectContaining({ title: "Cafe claro" }),
      expect.objectContaining({ title: "Otro" })
    ]);
    expect(collection.searchText("content", "!!!")).toEqual([]);
    expect(collection.searchText("content", "caf")).toEqual([]);
    expect(collection.searchText("content", "indice rapido")).toEqual([expect.objectContaining({ title: "Nuevo" })]);
  });

  it("Should synchronize text indexes and keep runtime state out of data", () => {
    const collection = db.getCollection("test");
    const document = collection.add({ title: "old token" })!;
    collection.createTextIndex("__runtime_text_index__", "title");
    collection.update({ ...document, title: "new token" });

    expect(collection.searchText("__runtime_text_index__", "old")).toEqual([]);
    expect(collection.searchText("__runtime_text_index__", "new")).toEqual([
      expect.objectContaining({ $id: document.$id })
    ]);
    collection.remove(document);
    expect(collection.searchText("__runtime_text_index__", "new")).toEqual([]);
    expect(JSON.stringify(db.data)).not.toContain("__runtime_text_index__");
    expect(collection.dropTextIndex("__runtime_text_index__")).toBe(true);
    expect(collection.getTextIndexes()).toEqual([]);
  });

  it("Should reindex a collection with no declared indexes", () => {
    const collection = db.getCollection("test");
    const data = db.data.collections.test.data;
    data.push({ name: "direct" });

    expect(collection.reindex()).toBe(collection);
    expect(collection.find()).toEqual([{ name: "direct" }]);
    expect(collection.getIndexes()).toEqual([]);
    expect(collection.getTextIndexes()).toEqual([]);
  });

  it("Should reindex exact and text indexes after direct mutations", () => {
    const collection = db.getCollection("test");
    collection.add({ tenant: "a", status: "old", body: "old token" });
    collection.add({ tenant: "b", status: "keep", body: "keep token" });
    collection.add({ tenant: "c", status: "replace", body: "replace token" });
    collection.createIndex("by-status", "status");
    collection.createIndex("by-tenant-status", ["tenant", "status"]);
    collection.createTextIndex("content", "body");
    const data = db.data.collections.test.data;

    data[0].status = "changed";
    data[0].body = "changed token";
    data.splice(1, 1);
    data[1] = {
      tenant: "c",
      status: "replacement",
      body: "replacement token"
    };
    data.push({ tenant: "a", status: "direct", body: "direct token" });

    collection.reindex();

    expect(collection.find({ status: "old" })).toEqual([]);
    expect(collection.find({ tenant: "a", status: "changed" })).toEqual([
      expect.objectContaining({ body: "changed token" })
    ]);
    expect(collection.find({ status: "keep" })).toEqual([]);
    expect(collection.find({ status: "replacement" })).toEqual([expect.objectContaining({ tenant: "c" })]);
    expect(collection.find({ tenant: "a", status: "direct" })).toEqual([
      expect.objectContaining({ body: "direct token" })
    ]);
    expect(collection.searchText("content", "old keep replace")).toEqual([]);
    expect(collection.searchText("content", "changed")).toEqual([expect.objectContaining({ status: "changed" })]);
    expect(collection.searchText("content", "replacement")).toEqual([
      expect.objectContaining({ status: "replacement" })
    ]);
    expect(collection.searchText("content", "direct")).toEqual([expect.objectContaining({ status: "direct" })]);
    expect(collection.getIndexes()).toEqual([
      { name: "by-status", fields: ["status"] },
      { name: "by-tenant-status", fields: ["tenant", "status"] }
    ]);
    expect(collection.getTextIndexes()).toEqual([{ name: "content", fields: ["body"] }]);
  });

  it("Should reindex shared wrappers and preserve current data order", () => {
    const first = db.getCollection("test");
    first.add({ status: "same", body: "first" });
    first.add({ status: "same", body: "second" });
    first.createIndex("by-status", "status");
    first.createTextIndex("content", "body");
    const second = db.getCollection("test");
    const data = db.data.collections.test.data;
    data.reverse();
    data[0].body = "changed";

    expect(second.reindex()).toBe(second);
    expect(first.find({ status: "same" })).toEqual([
      expect.objectContaining({ body: "changed" }),
      expect.objectContaining({ body: "first" })
    ]);
    expect(first.searchText("content", "changed")).toEqual([expect.objectContaining({ body: "changed" })]);
    expect(first.searchText("content", "second")).toEqual([]);
  });

  it("Should keep old index state when reindex construction fails", () => {
    const collection = db.getCollection("test");
    collection.add({ status: "stable", body: "stable token" });
    collection.createIndex("by-status", "status");
    collection.createTextIndex("content", "body");
    const collectionData = db.data.collections.test;
    const data = collectionData.data;
    const databaseCreatedAt = db.data.createdAt;
    const databaseModifiedAt = db.data.modifiedAt;
    const collectionCreatedAt = collectionData.createdAt;
    const collectionModifiedAt = collectionData.modifiedAt;
    let saveCalls = 0;
    db.save = () => {
      saveCalls += 1;
    };
    data.push({ status: "direct", body: "direct token" });
    const invalid = { status: "invalid" } as Record<string, any>;
    Object.defineProperty(invalid, "body", {
      enumerable: true,
      get(): never {
        throw new Error("index read failed");
      }
    });
    data.push(invalid);

    expect(() => collection.reindex()).toThrow("index read failed");
    expect(collection.find({ status: "direct" })).toEqual([]);
    expect(collection.find({ status: "stable" })).toEqual([expect.objectContaining({ body: "stable token" })]);
    expect(collection.searchText("content", "stable")).toEqual([expect.objectContaining({ status: "stable" })]);
    expect(saveCalls).toBe(0);
    expect(collectionData.data).toBe(data);
    expect(db.data.createdAt).toBe(databaseCreatedAt);
    expect(db.data.modifiedAt).toBe(databaseModifiedAt);
    expect(collectionData.createdAt).toBe(collectionCreatedAt);
    expect(collectionData.modifiedAt).toBe(collectionModifiedAt);
  });

  it("Should register each plugin once per target", () => {
    const collection = db.getCollection("test");
    let databaseCalls = 0;
    let collectionCalls = 0;
    const databasePlugin = (target: unknown, argument: string) => {
      expect(target).toBe(db);
      expect(argument).toBe("database");
      databaseCalls += 1;
    };
    const collectionPlugin = (target: unknown, argument: string) => {
      expect(target).toBe(collection);
      expect(argument).toBe("collection");
      collectionCalls += 1;
    };

    expect(db.use(databasePlugin, "database")).toBe(db);
    expect(db.use(databasePlugin, "database")).toBe(db);
    expect(collection.use(collectionPlugin, "collection")).toBe(collection);
    expect(collection.use(collectionPlugin, "collection")).toBe(collection);
    expect(databaseCalls).toBe(1);
    expect(collectionCalls).toBe(1);
  });

  it("Should add a document to a collection", () => {
    const collection = db.getCollection("test");
    const expected = {
      firstName: "John",
      lastName: "Doe",
      $id: 1,
      $createdAt: expect.any(Date),
      $modifiedAt: expect.any(Date)
    };

    const result = collection.add({ firstName: "John", lastName: "Doe" });
    expect(result).toEqual(expected);
    expect(db.data.collections.test.data).toEqual([expected]);
  });

  it("Should get a document by id", () => {
    const collection = db.getCollection("test");
    const expected = {
      firstName: "John",
      lastName: "Doe",
      $id: 1,
      $createdAt: expect.any(Date),
      $modifiedAt: expect.any(Date)
    };

    collection.add({ firstName: "John", lastName: "Doe" });
    expect(collection.get(expected.$id)).toEqual(expected);
  });

  it("Should findOne method to find a document for a single element", () => {
    const collection = db.getCollection("test");
    const expected = {
      firstName: "John",
      lastName: "Doe",
      $id: 1,
      $createdAt: expect.any(Date),
      $modifiedAt: expect.any(Date)
    };

    collection.add({ firstName: "John", lastName: "Doe" });
    expect(collection.findOne({ firstName: "John" })).toEqual(expected);
  });

  it("Should find method to find a set of documents", () => {
    const collection = db.getCollection("test");
    const expected = [
      {
        firstName: "John 2",
        lastName: "Doe 2",
        $id: 2,
        $createdAt: expect.any(Date),
        $modifiedAt: expect.any(Date)
      }
    ];

    collection.add({ firstName: "John", lastName: "Doe" });
    collection.add({ firstName: "John 2", lastName: "Doe 2" });
    collection.add({ firstName: "John 3", lastName: "Doe 3" });
    expect(collection.find({ firstName: "John 2" })).toEqual(expected);
  });

  it("Should match query fields with strict equality", () => {
    const collection = db.getCollection("test");
    const shared = { active: true };
    collection.add({ name: "matching", profile: shared });
    collection.add({ name: "different", profile: { active: true } });

    expect(collection.find({ name: "matching" })).toHaveLength(1);
    expect(collection.find({ profile: shared })).toHaveLength(1);
    expect(collection.find({})).toHaveLength(2);
  });

  it("Should reject unsupported query forms", () => {
    const collection = db.getCollection("test");
    collection.add({ active: true });

    const invalidQueries = ["active", ["active", true], () => true];
    for (let index = 0; index < invalidQueries.length; index += 1) {
      expect(() => collection.find(invalidQueries[index] as any)).toThrow(TypeError);
      expect(() => collection.findOne(invalidQueries[index] as any)).toThrow(TypeError);
      expect(() => collection.count(invalidQueries[index] as any)).toThrow(TypeError);
    }
  });

  it("Should preserve multi-key sort contract and stable ties", () => {
    const collection = db.getCollection("test");

    collection.add({ group: 1, score: 2, name: "first" });
    collection.add({ group: 1, score: 3, name: "second" });
    collection.add({ group: 2, score: 1, name: "third" });
    collection.add({ group: 1, score: 3, name: "fourth" });

    const result = collection.find({}, { sort: { group: 1, score: -1 } });

    const names: string[] = [];
    for (let index = 0; index < result.length; index += 1) {
      names.push(result[index].name);
    }
    expect(names).toEqual(["second", "fourth", "first", "third"]);
    collection.createIndex("by-group", "group");
    expect(collection.findOne({ group: 1 }, { sort: { group: 1, score: -1 } })!.name).toBe("second");
  });

  it("Should sort and isolate all documents when the query is undefined", () => {
    const collection = db.getCollection("test");
    collection.add({ score: 2, profile: { name: "second" } });
    collection.add({ score: 1, profile: { name: "first" } });

    const result = collection.find(undefined, { sort: { score: 1 } });

    expect(result).toEqual([
      expect.objectContaining({ score: 1, profile: { name: "first" } }),
      expect.objectContaining({ score: 2, profile: { name: "second" } })
    ]);
    result[0].profile.name = "changed";
    result.reverse();
    expect(collection.find(undefined, { sort: { score: 1 } })).toEqual([
      expect.objectContaining({ score: 1, profile: { name: "first" } }),
      expect.objectContaining({ score: 2, profile: { name: "second" } })
    ]);
  });

  it("Should reject invalid sort directions", () => {
    const collection = db.getCollection("test");

    expect(() => collection.sort([], { score: 0 } as any)).toThrow(TypeError);
    expect(() => collection.find({}, { sort: { score: 2 } } as any)).toThrow(TypeError);
    expect(() => collection.findOne({ missing: true }, { sort: { score: 0 } } as any)).toThrow(TypeError);
  });

  it("Should isolate returned documents with deep clones", () => {
    const collection = db.getCollection("test");
    const source = {
      name: "John",
      profile: { name: "John" },
      createdAt: new Date(0)
    };
    const added = collection.add({
      ...source
    })!;

    added.profile.name = "Changed after add";
    added.createdAt.setTime(1);
    expect(collection.get(added.$id)).toEqual(
      expect.objectContaining({
        profile: { name: "John" },
        createdAt: new Date(0)
      })
    );

    const found = collection.find({ name: "John" })[0];
    found.profile.name = "Changed after find";
    expect(collection.findOne({ name: "John" })!.profile.name).toBe("John");

    const updated = collection.update(Object.assign({}, found, { profile: { name: "Updated" } }));
    updated.profile.name = "Changed after update";
    expect(collection.get(updated.$id)!.profile.name).toBe("Updated");
  });

  it("Should preserve update, remove and count contracts", () => {
    const collection = db.getCollection("test");
    const original = collection.add({
      status: "new",
      active: true
    })!;
    collection.add({ status: "new", active: false });

    const updated = collection.update(
      Object.assign({}, original, {
        status: "done",
        $createdAt: new Date(0)
      })
    );

    expect(updated.status).toBe("done");
    expect(updated.$createdAt).toEqual(original.$createdAt);
    expect(collection.count({ active: false })).toBe(1);

    collection.remove(updated);
    expect(collection.count()).toBe(1);
    expect(typeof collection.get(updated.$id)).toBe("undefined");
    expect(() => collection.update(updated)).toThrow();
    expect(() => collection.remove(updated)).toThrow();
  });
});
