type Document = Record<string, any>;
type Query = Record<string, any>;
type SortOptions = Record<string, 1 | -1>;

interface CollectionData {
  data: Document[];
  index: number;
  createdAt: Date;
  modifiedAt: Date;
}

interface DatabaseData {
  collections: Record<string, CollectionData>;
  createdAt: Date;
  modifiedAt: Date;
}

interface CollectionBinding {
  active: boolean;
  data: CollectionData;
  runtime: CollectionRuntime;
}

interface StagedDatabaseData {
  data: DatabaseData;
  bindings: Map<string, { data: CollectionData; runtime: CollectionRuntime }>;
}

interface FindOptions {
  sort?: SortOptions;
}

interface IndexDefinition {
  name: string;
  fields: string[];
}

interface TextSearchOptions {
  operator?: "AND" | "OR";
}

interface ExactIndex extends IndexDefinition {
  root: Map<unknown, unknown>;
}

interface TextIndex extends IndexDefinition {
  postings: Map<string, Document[]>;
}

interface CollectionRuntime {
  exactIndexes: Map<string, ExactIndex>;
  textIndexes: Map<string, TextIndex>;
  order: Map<Document, number>;
  nextOrder: number;
}

interface Collection {
  sort(array: Document[], options?: SortOptions): Document[];
  find(query?: Query, options?: FindOptions): Document[];
  findOne(query?: Query, options?: FindOptions): Document | undefined;
  get(id: unknown): Document | undefined;
  update(document: Document): Document;
  count(query?: Query): number;
  add(document: Document): Document | undefined;
  remove(document: Document): void;
  createIndex(name: string, fields: string | string[]): Collection;
  getIndexes(): IndexDefinition[];
  dropIndex(name: string): boolean;
  createTextIndex(name: string, fields: string | string[]): Collection;
  getTextIndexes(): IndexDefinition[];
  dropTextIndex(name: string): boolean;
  reindex(): Collection;
  searchText(name: string, text: string, options?: TextSearchOptions): Document[];
  use(plugin: Plugin, ...args: any[]): Collection;
}

interface Database {
  data: DatabaseData;
  getCollection(name: string): Collection;
  save(): void;
  use(plugin: Plugin, ...args: any[]): Database;
}

type Plugin = (object: any, ...args: any[]) => void;

const emptyDocuments: Document[] = [];

interface IluDBStatic {
  (...args: any[]): Database;
  plugify(object: any): void;
  use(plugin: Plugin, ...args: any[]): IluDBStatic;
  getDatabase(...args: any[]): Database;
  getCollection(database: Database, name: string): Collection;
  _stageData(database: Database, data: DatabaseData): StagedDatabaseData;
  _publishData(database: Database, staged: StagedDatabaseData): void;
}

const databaseBindings = new WeakMap<Database, Map<string, CollectionBinding>>();

function assertActive(binding: CollectionBinding): void {
  if (!binding.active) {
    throw new Error("The collection is inactive after reload.");
  }
}

function assertQuery(query: unknown): asserts query is Query {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    (Object.getPrototypeOf(query) !== Object.prototype && Object.getPrototypeOf(query) !== null)
  ) {
    throw new TypeError("Query must be a plain object.");
  }
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name) {
    throw new TypeError("Index name must be a non-empty trimmed string.");
  }
}

function normalizeFields(fields: string | string[]): string[] {
  const values = typeof fields === "string" ? [fields] : fields;
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Index fields must contain at least one field.");
  }
  const normalized = new Array<string>(values.length);
  const unique = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const field = values[index];
    if (typeof field !== "string" || field.length === 0 || field.trim() !== field || unique.has(field)) {
      throw new TypeError("Index fields must be unique non-empty trimmed strings.");
    }
    unique.add(field);
    normalized[index] = field;
  }
  return normalized;
}

function selectExactCandidates(runtime: CollectionRuntime, query: Query): Document[] | null {
  let candidates: Document[] | null = null;
  let selectedFields = 0;
  for (const exactIndex of runtime.exactIndexes.values()) {
    const fields = exactIndex.fields;
    const fieldCount = fields.length;
    let covered = true;
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      if (!Object.hasOwn(query, fields[fieldIndex])) {
        covered = false;
        break;
      }
    }
    if (!covered) {
      continue;
    }
    let current = exactIndex.root;
    let posting: Document[] | null = null;
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      const next = current.get(query[fields[fieldIndex]]);
      if (typeof next === "undefined") {
        posting = emptyDocuments;
        break;
      }
      if (fieldIndex === fieldCount - 1) {
        posting = next as Document[];
      } else {
        current = next as Map<unknown, unknown>;
      }
    }
    posting ??= emptyDocuments;
    if (
      fieldCount > selectedFields ||
      (fieldCount === selectedFields && (candidates === null || posting.length < candidates.length))
    ) {
      selectedFields = fieldCount;
      candidates = posting;
    }
  }
  return candidates;
}

function getExactBucket(index: ExactIndex, values: Document): Document[] | null {
  let current = index.root;
  const fields = index.fields;
  const lastField = fields.length - 1;
  for (let fieldIndex = 0; fieldIndex <= lastField; fieldIndex += 1) {
    const field = fields[fieldIndex];
    if (!Object.hasOwn(values, field)) {
      return null;
    }
    const value = values[field];
    const last = fieldIndex === lastField;
    let next = current.get(value);
    if (typeof next === "undefined") {
      next = last ? [] : new Map<unknown, unknown>();
      current.set(value, next);
    }
    if (last) {
      return next as Document[];
    }
    current = next as Map<unknown, unknown>;
  }
  return null;
}

function addPosting(runtime: CollectionRuntime, posting: Document[], document: Document): void {
  const order = runtime.order.get(document)!;
  let index = posting.length;
  if (index === 0 || runtime.order.get(posting[index - 1])! <= order) {
    posting.push(document);
    return;
  }
  while (index > 0 && runtime.order.get(posting[index - 1])! > order) {
    index -= 1;
  }
  posting.splice(index, 0, document);
}

function removePosting(posting: Document[], document: Document): void {
  for (let index = 0; index < posting.length; index += 1) {
    if (posting[index] === document) {
      posting.splice(index, 1);
      return;
    }
  }
}

function addExactDocument(runtime: CollectionRuntime, index: ExactIndex, document: Document): void {
  const posting = getExactBucket(index, document);
  if (posting !== null) {
    addPosting(runtime, posting, document);
  }
}

function removeExactDocument(index: ExactIndex, document: Document): void {
  const maps = new Array<Map<unknown, unknown>>(index.fields.length);
  const values = new Array<unknown>(index.fields.length);
  let current = index.root;
  let posting: Document[] | null = null;
  for (let fieldIndex = 0; fieldIndex < index.fields.length; fieldIndex += 1) {
    const field = index.fields[fieldIndex];
    if (!Object.hasOwn(document, field)) {
      return;
    }
    const value = document[field];
    const next = current.get(value);
    if (typeof next === "undefined") {
      return;
    }
    maps[fieldIndex] = current;
    values[fieldIndex] = value;
    if (fieldIndex === index.fields.length - 1) {
      posting = next as Document[];
    } else {
      current = next as Map<unknown, unknown>;
    }
  }
  if (posting === null) {
    return;
  }
  removePosting(posting, document);
  if (posting.length > 0) {
    return;
  }
  for (let index = maps.length - 1; index >= 0; index -= 1) {
    maps[index].delete(values[index]);
    if (index === 0 || maps[index].size > 0) {
      break;
    }
  }
}

function tokenize(text: string): string[] {
  const parts = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  const tokens: string[] = [];
  const unique = new Set<string>();
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (token.length > 0 && !unique.has(token)) {
      unique.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

function getDocumentTokens(index: TextIndex, document: Document): string[] {
  if (index.fields.length === 1) {
    const value = document[index.fields[0]];
    return typeof value === "string" ? tokenize(value) : [];
  }
  let text = "";
  for (let fieldIndex = 0; fieldIndex < index.fields.length; fieldIndex += 1) {
    const value = document[index.fields[fieldIndex]];
    if (typeof value === "string") {
      text += ` ${value}`;
    }
  }
  return tokenize(text);
}

function addTextDocument(runtime: CollectionRuntime, index: TextIndex, document: Document): void {
  const tokens = getDocumentTokens(index, document);
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    let posting = index.postings.get(token);
    if (typeof posting === "undefined") {
      posting = [];
      index.postings.set(token, posting);
    }
    addPosting(runtime, posting, document);
  }
}

function removeTextDocument(index: TextIndex, document: Document): void {
  const tokens = getDocumentTokens(index, document);
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const posting = index.postings.get(token);
    if (typeof posting !== "undefined") {
      removePosting(posting, document);
      if (posting.length === 0) {
        index.postings.delete(token);
      }
    }
  }
}

function createRuntime(collection: CollectionData, previous?: CollectionRuntime): CollectionRuntime {
  const order = new Map<Document, number>();
  for (let index = 0; index < collection.data.length; index += 1) {
    order.set(collection.data[index], index);
  }
  const runtime: CollectionRuntime = {
    exactIndexes: new Map(),
    textIndexes: new Map(),
    order,
    nextOrder: collection.data.length
  };
  if (typeof previous === "undefined") {
    return runtime;
  }
  for (const current of previous.exactIndexes.values()) {
    const exactIndex: ExactIndex = {
      name: current.name,
      fields: current.fields.slice(),
      root: new Map()
    };
    for (let index = 0; index < collection.data.length; index += 1) {
      addExactDocument(runtime, exactIndex, collection.data[index]);
    }
    runtime.exactIndexes.set(exactIndex.name, exactIndex);
  }
  for (const current of previous.textIndexes.values()) {
    const textIndex: TextIndex = {
      name: current.name,
      fields: current.fields.slice(),
      postings: new Map()
    };
    for (let index = 0; index < collection.data.length; index += 1) {
      addTextDocument(runtime, textIndex, collection.data[index]);
    }
    runtime.textIndexes.set(textIndex.name, textIndex);
  }
  return runtime;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (Array.isArray(value)) {
    const clone = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      clone[index] = cloneValue(value[index]);
    }
    return clone as T;
  }
  const clone: Document = {};
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      clone[key] = cloneValue((value as Document)[key]);
    }
  }
  return clone as T;
}

function getSortKeys(options: SortOptions): string[] {
  const keys = Object.keys(options);
  for (let index = 0; index < keys.length; index += 1) {
    const direction = options[keys[index]];
    if (direction !== 1 && direction !== -1) {
      throw new TypeError("Sort direction must be 1 or -1.");
    }
  }
  return keys;
}

function compareDocuments(left: Document, right: Document, keys: string[], options: SortOptions): number {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (leftValue === null || typeof leftValue === "undefined") {
      return options[key];
    }
    if (rightValue === null || typeof rightValue === "undefined") {
      return -options[key];
    }
    return (leftValue < rightValue ? -1 : 1) * options[key];
  }
  return 0;
}

function sortDocuments(array: Document[], options: SortOptions): Document[] {
  const keys = getSortKeys(options);
  if (keys.length === 0) {
    return array;
  }

  const sorted = array.slice();
  sorted.sort((left, right) => compareDocuments(left, right, keys, options));
  return sorted;
}

const IluDB = function (...args: any[]): Database {
  return IluDB.getDatabase(...args);
} as IluDBStatic;

IluDB.plugify = function (object: any): void {
  const plugins: Plugin[] = [];
  object.use = function (plugin: Plugin, ...args: any[]): any {
    for (let index = 0; index < plugins.length; index += 1) {
      if (plugins[index] === plugin) {
        return object;
      }
    }
    plugin(object, ...args);
    plugins.push(plugin);
    return object;
  };
};

IluDB.plugify(IluDB);

IluDB.getDatabase = function (): Database {
  const database = {
    data: {
      collections: {},
      createdAt: new Date(),
      modifiedAt: new Date()
    },
    getCollection(name: string): Collection {
      return IluDB.getCollection(database, name);
    },
    save(): void {}
  } as Database;
  databaseBindings.set(database, new Map());
  IluDB.plugify(database);
  return database;
};

IluDB._stageData = function (database: Database, data: DatabaseData): StagedDatabaseData {
  const currentBindings = databaseBindings.get(database) ?? new Map();
  const stagedBindings = new Map<string, { data: CollectionData; runtime: CollectionRuntime }>();
  const names = Object.keys(data.collections);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const current = currentBindings.get(name);
    stagedBindings.set(name, {
      data: data.collections[name],
      runtime: createRuntime(data.collections[name], typeof current === "undefined" ? undefined : current.runtime)
    });
  }
  return { data, bindings: stagedBindings };
};

IluDB._publishData = function (database: Database, staged: StagedDatabaseData): void {
  let bindings = databaseBindings.get(database);
  if (typeof bindings === "undefined") {
    bindings = new Map();
    databaseBindings.set(database, bindings);
  }
  for (const [name, binding] of bindings) {
    const replacement = staged.bindings.get(name);
    if (typeof replacement === "undefined") {
      binding.active = false;
    } else {
      binding.active = true;
      binding.data = replacement.data;
      binding.runtime = replacement.runtime;
    }
  }
  database.data = staged.data;
};

IluDB.getCollection = function (database: Database, name: string): Collection {
  let bindings = databaseBindings.get(database);
  if (typeof bindings === "undefined") {
    bindings = new Map();
    databaseBindings.set(database, bindings);
  }
  if (typeof database.data.collections[name] === "undefined") {
    database.data.collections[name] = {
      data: [],
      index: 0,
      createdAt: new Date(),
      modifiedAt: new Date()
    };
  }
  let binding = bindings.get(name);
  if (typeof binding === "undefined") {
    const collection = database.data.collections[name];
    binding = {
      active: true,
      data: collection,
      runtime: createRuntime(collection)
    };
    bindings.set(name, binding);
  } else if (!binding.active) {
    const collection = database.data.collections[name];
    binding.active = true;
    binding.data = collection;
    binding.runtime = createRuntime(collection, binding.runtime);
  }

  const collection = new Proxy({} as CollectionData, {
    get(_target, key): unknown {
      assertActive(binding);
      return Reflect.get(binding.data, key);
    },
    set(_target, key, value): boolean {
      assertActive(binding);
      return Reflect.set(binding.data, key, value);
    }
  });
  const runtime = new Proxy({} as CollectionRuntime, {
    get(_target, key): unknown {
      assertActive(binding);
      return Reflect.get(binding.runtime, key);
    },
    set(_target, key, value): boolean {
      assertActive(binding);
      return Reflect.set(binding.runtime, key, value);
    }
  });

  const model = {
    sort(array: Document[], options: SortOptions = {}): Document[] {
      return sortDocuments(array, options);
    },
    find(query?: Query, options?: FindOptions): Document[] {
      let documents = collection.data;
      if (typeof query !== "undefined") {
        assertQuery(query);
        const keys = Object.keys(query);
        if (keys.length > 0) {
          const candidates = selectExactCandidates(runtime, query);
          documents = [];
          const source = candidates === null ? collection.data : candidates;
          for (let index = 0; index < source.length; index += 1) {
            const document = source[index];
            let matches = true;
            for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
              const key = keys[keyIndex];
              if (!Object.hasOwn(document, key) || document[key] !== query[key]) {
                matches = false;
                break;
              }
            }
            if (matches) {
              documents.push(document);
            }
          }
        }
      }
      if (typeof options !== "undefined" && typeof options.sort !== "undefined") {
        documents = sortDocuments(documents, options.sort);
      }
      const result = documents === collection.data ? new Array<Document>(documents.length) : documents;
      for (let index = 0; index < documents.length; index += 1) {
        result[index] = cloneValue(documents[index]);
      }
      return result;
    },
    findOne(query?: Query, options?: FindOptions): Document | undefined {
      if (typeof query === "undefined") {
        const documents =
          typeof options !== "undefined" && typeof options.sort !== "undefined"
            ? sortDocuments(collection.data, options.sort)
            : collection.data;
        return documents.length === 0 ? undefined : cloneValue(documents[0]);
      }
      assertQuery(query);
      const keys = Object.keys(query);
      const sort = options?.sort;
      if (typeof sort !== "undefined") {
        const sortKeys = getSortKeys(sort);
        let source = collection.data;
        if (keys.length > 0) {
          const candidates = selectExactCandidates(runtime, query);
          if (candidates !== null) {
            source = candidates;
          }
        }
        let selected: Document | undefined;
        for (let index = 0; index < source.length; index += 1) {
          const document = source[index];
          let matchesQuery = true;
          for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
            const key = keys[keyIndex];
            if (!Object.hasOwn(document, key) || document[key] !== query[key]) {
              matchesQuery = false;
              break;
            }
          }
          if (matchesQuery) {
            if (typeof selected === "undefined") {
              selected = document;
              continue;
            }
            if (compareDocuments(document, selected, sortKeys, sort) < 0) {
              selected = document;
            }
          }
        }
        return typeof selected === "undefined" ? undefined : cloneValue(selected);
      }
      let documents = collection.data;
      if (keys.length > 0) {
        const candidates = selectExactCandidates(runtime, query);
        if (candidates !== null) {
          documents = candidates;
        }
      }
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        let matches = true;
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (!Object.hasOwn(document, key) || document[key] !== query[key]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          return cloneValue(document);
        }
      }
    },
    get(id: unknown): Document | undefined {
      for (let index = 0; index < collection.data.length; index += 1) {
        if (collection.data[index].$id === id) {
          return cloneValue(collection.data[index]);
        }
      }
    },
    update(document: Document): Document {
      for (let index = 0; index < collection.data.length; index += 1) {
        const stored = collection.data[index];
        if (stored.$id !== document.$id) {
          continue;
        }
        const affectedExact: ExactIndex[] = [];
        for (const exactIndex of runtime.exactIndexes.values()) {
          let affected = false;
          for (let fieldIndex = 0; fieldIndex < exactIndex.fields.length; fieldIndex += 1) {
            const field = exactIndex.fields[fieldIndex];
            if (
              field === "$modifiedAt" ||
              (Object.hasOwn(document, field) && (!Object.hasOwn(stored, field) || stored[field] !== document[field]))
            ) {
              affected = true;
              break;
            }
          }
          if (affected) {
            affectedExact.push(exactIndex);
            removeExactDocument(exactIndex, stored);
          }
        }
        const affectedText: TextIndex[] = [];
        for (const textIndex of runtime.textIndexes.values()) {
          let affected = false;
          for (let fieldIndex = 0; fieldIndex < textIndex.fields.length; fieldIndex += 1) {
            const field = textIndex.fields[fieldIndex];
            if (
              field === "$modifiedAt" ||
              (Object.hasOwn(document, field) && (!Object.hasOwn(stored, field) || stored[field] !== document[field]))
            ) {
              affected = true;
              break;
            }
          }
          if (affected) {
            affectedText.push(textIndex);
            removeTextDocument(textIndex, stored);
          }
        }
        const keys = Object.keys(document);
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (key !== "$id" && key !== "$createdAt" && key !== "$modifiedAt") {
            stored[key] = document[key];
          }
        }
        stored.$modifiedAt = collection.modifiedAt = new Date();
        for (let indexIndex = 0; indexIndex < affectedExact.length; indexIndex += 1) {
          addExactDocument(runtime, affectedExact[indexIndex], stored);
        }
        for (let indexIndex = 0; indexIndex < affectedText.length; indexIndex += 1) {
          addTextDocument(runtime, affectedText[indexIndex], stored);
        }
        database.save();
        return cloneValue(stored);
      }
      throw new Error("The document does not exist.");
    },
    count(query?: Query): number {
      if (typeof query === "undefined") {
        return collection.data.length;
      }
      assertQuery(query);
      const keys = Object.keys(query);
      if (keys.length === 0) {
        return collection.data.length;
      }
      const candidates = selectExactCandidates(runtime, query);
      const documents = candidates === null ? collection.data : candidates;
      let count = 0;
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        let matches = true;
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (!Object.hasOwn(document, key) || document[key] !== query[key]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          count += 1;
        }
      }
      return count;
    },
    add(document: Document): Document | undefined {
      if (document === null || typeof document !== "object" || Array.isArray(document)) {
        return;
      }
      if (Object.hasOwn(document, "$id")) {
        throw new Error("The $id property is reserved.");
      }
      if (Object.hasOwn(document, "$createdAt")) {
        throw new Error("The $createdAt property is reserved.");
      }
      if (Object.hasOwn(document, "$modifiedAt")) {
        throw new Error("The $modifiedAt property is reserved.");
      }

      collection.index += 1;
      document.$id = collection.index;
      const now = new Date();
      document.$createdAt = now;
      document.$modifiedAt = now;
      collection.data.push(document);
      runtime.order.set(document, runtime.nextOrder);
      runtime.nextOrder += 1;
      for (const exactIndex of runtime.exactIndexes.values()) {
        addExactDocument(runtime, exactIndex, document);
      }
      for (const textIndex of runtime.textIndexes.values()) {
        addTextDocument(runtime, textIndex, document);
      }
      collection.modifiedAt = now;
      database.save();
      return cloneValue(document);
    },
    remove(document: Document): void {
      for (let index = 0; index < collection.data.length; index += 1) {
        if (collection.data[index].$id === document.$id) {
          const stored = collection.data[index];
          for (const exactIndex of runtime.exactIndexes.values()) {
            removeExactDocument(exactIndex, stored);
          }
          for (const textIndex of runtime.textIndexes.values()) {
            removeTextDocument(textIndex, stored);
          }
          collection.data.splice(index, 1);
          runtime.order.delete(stored);
          collection.modifiedAt = new Date();
          database.save();
          return;
        }
      }
      throw new Error("The document does not exist.");
    },
    createIndex(name: string, fields: string | string[]): Collection {
      assertName(name);
      const normalizedFields = normalizeFields(fields);
      if (runtime.exactIndexes.has(name) || runtime.textIndexes.has(name)) {
        throw new Error(`The index "${name}" already exists.`);
      }
      const exactIndex: ExactIndex = {
        name,
        fields: normalizedFields,
        root: new Map()
      };
      for (let index = 0; index < collection.data.length; index += 1) {
        const document = collection.data[index];
        const posting = getExactBucket(exactIndex, document);
        if (posting !== null) {
          posting.push(document);
        }
      }
      runtime.exactIndexes.set(name, exactIndex);
      return model;
    },
    getIndexes(): IndexDefinition[] {
      const definitions: IndexDefinition[] = [];
      for (const index of runtime.exactIndexes.values()) {
        definitions.push({
          name: index.name,
          fields: index.fields.slice()
        });
      }
      return definitions;
    },
    dropIndex(name: string): boolean {
      assertName(name);
      return runtime.exactIndexes.delete(name);
    },
    createTextIndex(name: string, fields: string | string[]): Collection {
      assertName(name);
      const normalizedFields = normalizeFields(fields);
      if (runtime.exactIndexes.has(name) || runtime.textIndexes.has(name)) {
        throw new Error(`The index "${name}" already exists.`);
      }
      const textIndex: TextIndex = {
        name,
        fields: normalizedFields,
        postings: new Map()
      };
      for (let index = 0; index < collection.data.length; index += 1) {
        const document = collection.data[index];
        const tokens = getDocumentTokens(textIndex, document);
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
          const token = tokens[tokenIndex];
          let posting = textIndex.postings.get(token);
          if (typeof posting === "undefined") {
            posting = [];
            textIndex.postings.set(token, posting);
          }
          posting.push(document);
        }
      }
      runtime.textIndexes.set(name, textIndex);
      return model;
    },
    getTextIndexes(): IndexDefinition[] {
      const definitions: IndexDefinition[] = [];
      for (const index of runtime.textIndexes.values()) {
        definitions.push({
          name: index.name,
          fields: index.fields.slice()
        });
      }
      return definitions;
    },
    dropTextIndex(name: string): boolean {
      assertName(name);
      return runtime.textIndexes.delete(name);
    },
    reindex(): Collection {
      const exactIndexes = new Map<string, ExactIndex>();
      const textIndexes = new Map<string, TextIndex>();
      const order = new Map<Document, number>();
      for (let index = 0; index < collection.data.length; index += 1) {
        order.set(collection.data[index], index);
      }
      for (const current of runtime.exactIndexes.values()) {
        const exactIndex: ExactIndex = {
          name: current.name,
          fields: current.fields,
          root: new Map()
        };
        for (let index = 0; index < collection.data.length; index += 1) {
          const posting = getExactBucket(exactIndex, collection.data[index]);
          if (posting !== null) {
            posting.push(collection.data[index]);
          }
        }
        exactIndexes.set(exactIndex.name, exactIndex);
      }
      for (const current of runtime.textIndexes.values()) {
        const textIndex: TextIndex = {
          name: current.name,
          fields: current.fields,
          postings: new Map()
        };
        for (let index = 0; index < collection.data.length; index += 1) {
          const document = collection.data[index];
          const tokens = getDocumentTokens(textIndex, document);
          for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
            const token = tokens[tokenIndex];
            let posting = textIndex.postings.get(token);
            if (typeof posting === "undefined") {
              posting = [];
              textIndex.postings.set(token, posting);
            }
            posting.push(document);
          }
        }
        textIndexes.set(textIndex.name, textIndex);
      }
      runtime.exactIndexes = exactIndexes;
      runtime.textIndexes = textIndexes;
      runtime.order = order;
      runtime.nextOrder = collection.data.length;
      return model;
    },
    searchText(name: string, text: string, options: TextSearchOptions = {}): Document[] {
      assertName(name);
      if (typeof text !== "string") {
        throw new TypeError("Search text must be a string.");
      }
      if (options === null || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Text search options must be an object.");
      }
      const operator = options.operator ?? "AND";
      if (operator !== "AND" && operator !== "OR") {
        throw new TypeError("Text search operator must be AND or OR.");
      }
      const textIndex = runtime.textIndexes.get(name);
      if (typeof textIndex === "undefined") {
        throw new Error(`The text index "${name}" does not exist.`);
      }
      const tokens = tokenize(text);
      if (tokens.length === 0) {
        return [];
      }

      let documents: Document[];
      if (operator === "AND") {
        let smallest: Document[] | null = null;
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
          const posting = textIndex.postings.get(tokens[tokenIndex]);
          if (typeof posting === "undefined") {
            return [];
          }
          if (smallest === null || posting.length < smallest.length) {
            smallest = posting;
          }
        }
        documents = smallest!.slice();
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
          const posting = textIndex.postings.get(tokens[tokenIndex])!;
          if (posting === smallest) {
            continue;
          }
          if (documents.length === 1) {
            if (posting.indexOf(documents[0]) === -1) {
              return [];
            }
            continue;
          }
          const included = new Set(posting);
          let writeIndex = 0;
          for (let index = 0; index < documents.length; index += 1) {
            if (included.has(documents[index])) {
              documents[writeIndex] = documents[index];
              writeIndex += 1;
            }
          }
          documents.length = writeIndex;
          if (documents.length === 0) {
            return [];
          }
        }
      } else {
        documents = [];
        const included = new Set<Document>();
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
          const posting = textIndex.postings.get(tokens[tokenIndex]);
          if (typeof posting === "undefined") {
            continue;
          }
          for (let index = 0; index < posting.length; index += 1) {
            const document = posting[index];
            if (!included.has(document)) {
              included.add(document);
              documents.push(document);
            }
          }
        }
        documents.sort((left, right) => runtime.order.get(left)! - runtime.order.get(right)!);
      }
      for (let index = 0; index < documents.length; index += 1) {
        documents[index] = cloneValue(documents[index]);
      }
      return documents;
    }
  } as Collection;

  IluDB.plugify(model);
  return model;
};

export default IluDB;
