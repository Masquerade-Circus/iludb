(function (root, factory) {
    if (typeof module === "object" && module && module.exports) {
        module.exports = factory(require);
        return;
    }
    if (typeof define === "function" && define.amd) {
        define(function () { return factory(null); });
        return;
    }
    root.IluDB = factory(
        typeof root.require === "function" ? root.require : null,
    );
})(typeof globalThis === "object" ? globalThis : this, function (externalRequire) {
    const module = { exports: {} };
    const exports = module.exports;
    const require = externalRequire ?? function (id) {
        throw new Error("External module is unavailable in this runtime: " + id);
    };
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/web.ts
var exports_web = {};
__export(exports_web, {
  default: () => web_default
});
module.exports = __toCommonJS(exports_web);

// src/index.ts
var emptyDocuments = [];
var databaseBindings = new WeakMap;
function assertActive(binding) {
  if (!binding.active) {
    throw new Error("The collection is inactive after reload.");
  }
}
function assertQuery(query) {
  if (query === null || typeof query !== "object" || Array.isArray(query) || Object.getPrototypeOf(query) !== Object.prototype && Object.getPrototypeOf(query) !== null) {
    throw new TypeError("Query must be a plain object.");
  }
}
function assertName(name) {
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name) {
    throw new TypeError("Index name must be a non-empty trimmed string.");
  }
}
function normalizeFields(fields) {
  const values = typeof fields === "string" ? [fields] : fields;
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Index fields must contain at least one field.");
  }
  const normalized = new Array(values.length);
  const unique = new Set;
  for (let index = 0;index < values.length; index += 1) {
    const field = values[index];
    if (typeof field !== "string" || field.length === 0 || field.trim() !== field || unique.has(field)) {
      throw new TypeError("Index fields must be unique non-empty trimmed strings.");
    }
    unique.add(field);
    normalized[index] = field;
  }
  return normalized;
}
function selectExactCandidates(runtime, query) {
  let candidates = null;
  let selectedFields = 0;
  for (const exactIndex of runtime.exactIndexes.values()) {
    const fields = exactIndex.fields;
    const fieldCount = fields.length;
    let covered = true;
    for (let fieldIndex = 0;fieldIndex < fieldCount; fieldIndex += 1) {
      if (!Object.hasOwn(query, fields[fieldIndex])) {
        covered = false;
        break;
      }
    }
    if (!covered) {
      continue;
    }
    let current = exactIndex.root;
    let posting = null;
    for (let fieldIndex = 0;fieldIndex < fieldCount; fieldIndex += 1) {
      const next = current.get(query[fields[fieldIndex]]);
      if (typeof next === "undefined") {
        posting = emptyDocuments;
        break;
      }
      if (fieldIndex === fieldCount - 1) {
        posting = next;
      } else {
        current = next;
      }
    }
    posting ??= emptyDocuments;
    if (fieldCount > selectedFields || fieldCount === selectedFields && (candidates === null || posting.length < candidates.length)) {
      selectedFields = fieldCount;
      candidates = posting;
    }
  }
  return candidates;
}
function getExactBucket(index, values) {
  let current = index.root;
  const fields = index.fields;
  const lastField = fields.length - 1;
  for (let fieldIndex = 0;fieldIndex <= lastField; fieldIndex += 1) {
    const field = fields[fieldIndex];
    if (!Object.hasOwn(values, field)) {
      return null;
    }
    const value = values[field];
    const last = fieldIndex === lastField;
    let next = current.get(value);
    if (typeof next === "undefined") {
      next = last ? [] : new Map;
      current.set(value, next);
    }
    if (last) {
      return next;
    }
    current = next;
  }
  return null;
}
function addPosting(runtime, posting, document) {
  const order = runtime.order.get(document);
  let index = posting.length;
  if (index === 0 || runtime.order.get(posting[index - 1]) <= order) {
    posting.push(document);
    return;
  }
  while (index > 0 && runtime.order.get(posting[index - 1]) > order) {
    index -= 1;
  }
  posting.splice(index, 0, document);
}
function removePosting(posting, document) {
  for (let index = 0;index < posting.length; index += 1) {
    if (posting[index] === document) {
      posting.splice(index, 1);
      return;
    }
  }
}
function addExactDocument(runtime, index, document) {
  const posting = getExactBucket(index, document);
  if (posting !== null) {
    addPosting(runtime, posting, document);
  }
}
function removeExactDocument(index, document) {
  const maps = new Array(index.fields.length);
  const values = new Array(index.fields.length);
  let current = index.root;
  let posting = null;
  for (let fieldIndex = 0;fieldIndex < index.fields.length; fieldIndex += 1) {
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
      posting = next;
    } else {
      current = next;
    }
  }
  if (posting === null) {
    return;
  }
  removePosting(posting, document);
  if (posting.length > 0) {
    return;
  }
  for (let index2 = maps.length - 1;index2 >= 0; index2 -= 1) {
    maps[index2].delete(values[index2]);
    if (index2 === 0 || maps[index2].size > 0) {
      break;
    }
  }
}
function tokenize(text) {
  const parts = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const tokens = [];
  const unique = new Set;
  for (let index = 0;index < parts.length; index += 1) {
    const token = parts[index];
    if (token.length > 0 && !unique.has(token)) {
      unique.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}
function getDocumentTokens(index, document) {
  if (index.fields.length === 1) {
    const value = document[index.fields[0]];
    return typeof value === "string" ? tokenize(value) : [];
  }
  let text = "";
  for (let fieldIndex = 0;fieldIndex < index.fields.length; fieldIndex += 1) {
    const value = document[index.fields[fieldIndex]];
    if (typeof value === "string") {
      text += ` ${value}`;
    }
  }
  return tokenize(text);
}
function addTextDocument(runtime, index, document) {
  const tokens = getDocumentTokens(index, document);
  for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    let posting = index.postings.get(token);
    if (typeof posting === "undefined") {
      posting = [];
      index.postings.set(token, posting);
    }
    addPosting(runtime, posting, document);
  }
}
function removeTextDocument(index, document) {
  const tokens = getDocumentTokens(index, document);
  for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
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
function createRuntime(collection, previous) {
  const order = new Map;
  for (let index = 0;index < collection.data.length; index += 1) {
    order.set(collection.data[index], index);
  }
  const runtime = {
    exactIndexes: new Map,
    textIndexes: new Map,
    order,
    nextOrder: collection.data.length
  };
  if (typeof previous === "undefined") {
    return runtime;
  }
  for (const current of previous.exactIndexes.values()) {
    const exactIndex = {
      name: current.name,
      fields: current.fields.slice(),
      root: new Map
    };
    for (let index = 0;index < collection.data.length; index += 1) {
      addExactDocument(runtime, exactIndex, collection.data[index]);
    }
    runtime.exactIndexes.set(exactIndex.name, exactIndex);
  }
  for (const current of previous.textIndexes.values()) {
    const textIndex = {
      name: current.name,
      fields: current.fields.slice(),
      postings: new Map
    };
    for (let index = 0;index < collection.data.length; index += 1) {
      addTextDocument(runtime, textIndex, collection.data[index]);
    }
    runtime.textIndexes.set(textIndex.name, textIndex);
  }
  return runtime;
}
function cloneValue(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    const clone2 = new Array(value.length);
    for (let index = 0;index < value.length; index += 1) {
      clone2[index] = cloneValue(value[index]);
    }
    return clone2;
  }
  const clone = {};
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      clone[key] = cloneValue(value[key]);
    }
  }
  return clone;
}
function getSortKeys(options) {
  const keys = Object.keys(options);
  for (let index = 0;index < keys.length; index += 1) {
    const direction = options[keys[index]];
    if (direction !== 1 && direction !== -1) {
      throw new TypeError("Sort direction must be 1 or -1.");
    }
  }
  return keys;
}
function compareDocuments(left, right, keys, options) {
  for (let index = 0;index < keys.length; index += 1) {
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
function sortDocuments(array, options) {
  const keys = getSortKeys(options);
  if (keys.length === 0) {
    return array;
  }
  const sorted = array.slice();
  sorted.sort((left, right) => compareDocuments(left, right, keys, options));
  return sorted;
}
var IluDB = function(...args) {
  return IluDB.getDatabase(...args);
};
IluDB.plugify = function(object) {
  const plugins = [];
  object.use = function(plugin, ...args) {
    for (let index = 0;index < plugins.length; index += 1) {
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
IluDB.getDatabase = function() {
  const database = {
    data: {
      collections: {},
      createdAt: new Date,
      modifiedAt: new Date
    },
    getCollection(name) {
      return IluDB.getCollection(database, name);
    },
    save() {}
  };
  databaseBindings.set(database, new Map);
  IluDB.plugify(database);
  return database;
};
IluDB._stageData = function(database, data) {
  const currentBindings = databaseBindings.get(database) ?? new Map;
  const stagedBindings = new Map;
  const names = Object.keys(data.collections);
  for (let index = 0;index < names.length; index += 1) {
    const name = names[index];
    const current = currentBindings.get(name);
    stagedBindings.set(name, {
      data: data.collections[name],
      runtime: createRuntime(data.collections[name], typeof current === "undefined" ? undefined : current.runtime)
    });
  }
  return { data, bindings: stagedBindings };
};
IluDB._publishData = function(database, staged) {
  let bindings = databaseBindings.get(database);
  if (typeof bindings === "undefined") {
    bindings = new Map;
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
IluDB.getCollection = function(database, name) {
  let bindings = databaseBindings.get(database);
  if (typeof bindings === "undefined") {
    bindings = new Map;
    databaseBindings.set(database, bindings);
  }
  if (typeof database.data.collections[name] === "undefined") {
    database.data.collections[name] = {
      data: [],
      index: 0,
      createdAt: new Date,
      modifiedAt: new Date
    };
  }
  let binding = bindings.get(name);
  if (typeof binding === "undefined") {
    const collection2 = database.data.collections[name];
    binding = {
      active: true,
      data: collection2,
      runtime: createRuntime(collection2)
    };
    bindings.set(name, binding);
  } else if (!binding.active) {
    const collection2 = database.data.collections[name];
    binding.active = true;
    binding.data = collection2;
    binding.runtime = createRuntime(collection2, binding.runtime);
  }
  const collection = new Proxy({}, {
    get(_target, key) {
      assertActive(binding);
      return Reflect.get(binding.data, key);
    },
    set(_target, key, value) {
      assertActive(binding);
      return Reflect.set(binding.data, key, value);
    }
  });
  const runtime = new Proxy({}, {
    get(_target, key) {
      assertActive(binding);
      return Reflect.get(binding.runtime, key);
    },
    set(_target, key, value) {
      assertActive(binding);
      return Reflect.set(binding.runtime, key, value);
    }
  });
  const model = {
    sort(array, options = {}) {
      return sortDocuments(array, options);
    },
    find(query, options) {
      let documents = collection.data;
      if (typeof query !== "undefined") {
        assertQuery(query);
        const keys = Object.keys(query);
        if (keys.length > 0) {
          const candidates = selectExactCandidates(runtime, query);
          documents = [];
          const source = candidates === null ? collection.data : candidates;
          for (let index = 0;index < source.length; index += 1) {
            const document = source[index];
            let matches = true;
            for (let keyIndex = 0;keyIndex < keys.length; keyIndex += 1) {
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
      const result = documents === collection.data ? new Array(documents.length) : documents;
      for (let index = 0;index < documents.length; index += 1) {
        result[index] = cloneValue(documents[index]);
      }
      return result;
    },
    findOne(query, options) {
      if (typeof query === "undefined") {
        const documents2 = typeof options !== "undefined" && typeof options.sort !== "undefined" ? sortDocuments(collection.data, options.sort) : collection.data;
        return documents2.length === 0 ? undefined : cloneValue(documents2[0]);
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
        let selected;
        for (let index = 0;index < source.length; index += 1) {
          const document = source[index];
          let matchesQuery = true;
          for (let keyIndex = 0;keyIndex < keys.length; keyIndex += 1) {
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
      for (let index = 0;index < documents.length; index += 1) {
        const document = documents[index];
        let matches = true;
        for (let keyIndex = 0;keyIndex < keys.length; keyIndex += 1) {
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
    get(id) {
      for (let index = 0;index < collection.data.length; index += 1) {
        if (collection.data[index].$id === id) {
          return cloneValue(collection.data[index]);
        }
      }
    },
    update(document) {
      for (let index = 0;index < collection.data.length; index += 1) {
        const stored = collection.data[index];
        if (stored.$id !== document.$id) {
          continue;
        }
        const affectedExact = [];
        for (const exactIndex of runtime.exactIndexes.values()) {
          let affected = false;
          for (let fieldIndex = 0;fieldIndex < exactIndex.fields.length; fieldIndex += 1) {
            const field = exactIndex.fields[fieldIndex];
            if (field === "$modifiedAt" || Object.hasOwn(document, field) && (!Object.hasOwn(stored, field) || stored[field] !== document[field])) {
              affected = true;
              break;
            }
          }
          if (affected) {
            affectedExact.push(exactIndex);
            removeExactDocument(exactIndex, stored);
          }
        }
        const affectedText = [];
        for (const textIndex of runtime.textIndexes.values()) {
          let affected = false;
          for (let fieldIndex = 0;fieldIndex < textIndex.fields.length; fieldIndex += 1) {
            const field = textIndex.fields[fieldIndex];
            if (field === "$modifiedAt" || Object.hasOwn(document, field) && (!Object.hasOwn(stored, field) || stored[field] !== document[field])) {
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
        for (let keyIndex = 0;keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (key !== "$id" && key !== "$createdAt" && key !== "$modifiedAt") {
            stored[key] = document[key];
          }
        }
        stored.$modifiedAt = collection.modifiedAt = new Date;
        for (let indexIndex = 0;indexIndex < affectedExact.length; indexIndex += 1) {
          addExactDocument(runtime, affectedExact[indexIndex], stored);
        }
        for (let indexIndex = 0;indexIndex < affectedText.length; indexIndex += 1) {
          addTextDocument(runtime, affectedText[indexIndex], stored);
        }
        database.save();
        return cloneValue(stored);
      }
      throw new Error("The document does not exist.");
    },
    count(query) {
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
      for (let index = 0;index < documents.length; index += 1) {
        const document = documents[index];
        let matches = true;
        for (let keyIndex = 0;keyIndex < keys.length; keyIndex += 1) {
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
    add(document) {
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
      const now = new Date;
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
    remove(document) {
      for (let index = 0;index < collection.data.length; index += 1) {
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
          collection.modifiedAt = new Date;
          database.save();
          return;
        }
      }
      throw new Error("The document does not exist.");
    },
    createIndex(name2, fields) {
      assertName(name2);
      const normalizedFields = normalizeFields(fields);
      if (runtime.exactIndexes.has(name2) || runtime.textIndexes.has(name2)) {
        throw new Error(`The index "${name2}" already exists.`);
      }
      const exactIndex = {
        name: name2,
        fields: normalizedFields,
        root: new Map
      };
      for (let index = 0;index < collection.data.length; index += 1) {
        const document = collection.data[index];
        const posting = getExactBucket(exactIndex, document);
        if (posting !== null) {
          posting.push(document);
        }
      }
      runtime.exactIndexes.set(name2, exactIndex);
      return model;
    },
    getIndexes() {
      const definitions = [];
      for (const index of runtime.exactIndexes.values()) {
        definitions.push({
          name: index.name,
          fields: index.fields.slice()
        });
      }
      return definitions;
    },
    dropIndex(name2) {
      assertName(name2);
      return runtime.exactIndexes.delete(name2);
    },
    createTextIndex(name2, fields) {
      assertName(name2);
      const normalizedFields = normalizeFields(fields);
      if (runtime.exactIndexes.has(name2) || runtime.textIndexes.has(name2)) {
        throw new Error(`The index "${name2}" already exists.`);
      }
      const textIndex = {
        name: name2,
        fields: normalizedFields,
        postings: new Map
      };
      for (let index = 0;index < collection.data.length; index += 1) {
        const document = collection.data[index];
        const tokens = getDocumentTokens(textIndex, document);
        for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
          const token = tokens[tokenIndex];
          let posting = textIndex.postings.get(token);
          if (typeof posting === "undefined") {
            posting = [];
            textIndex.postings.set(token, posting);
          }
          posting.push(document);
        }
      }
      runtime.textIndexes.set(name2, textIndex);
      return model;
    },
    getTextIndexes() {
      const definitions = [];
      for (const index of runtime.textIndexes.values()) {
        definitions.push({
          name: index.name,
          fields: index.fields.slice()
        });
      }
      return definitions;
    },
    dropTextIndex(name2) {
      assertName(name2);
      return runtime.textIndexes.delete(name2);
    },
    reindex() {
      const exactIndexes = new Map;
      const textIndexes = new Map;
      const order = new Map;
      for (let index = 0;index < collection.data.length; index += 1) {
        order.set(collection.data[index], index);
      }
      for (const current of runtime.exactIndexes.values()) {
        const exactIndex = {
          name: current.name,
          fields: current.fields,
          root: new Map
        };
        for (let index = 0;index < collection.data.length; index += 1) {
          const posting = getExactBucket(exactIndex, collection.data[index]);
          if (posting !== null) {
            posting.push(collection.data[index]);
          }
        }
        exactIndexes.set(exactIndex.name, exactIndex);
      }
      for (const current of runtime.textIndexes.values()) {
        const textIndex = {
          name: current.name,
          fields: current.fields,
          postings: new Map
        };
        for (let index = 0;index < collection.data.length; index += 1) {
          const document = collection.data[index];
          const tokens = getDocumentTokens(textIndex, document);
          for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
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
    searchText(name2, text, options = {}) {
      assertName(name2);
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
      const textIndex = runtime.textIndexes.get(name2);
      if (typeof textIndex === "undefined") {
        throw new Error(`The text index "${name2}" does not exist.`);
      }
      const tokens = tokenize(text);
      if (tokens.length === 0) {
        return [];
      }
      let documents;
      if (operator === "AND") {
        let smallest = null;
        for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
          const posting = textIndex.postings.get(tokens[tokenIndex]);
          if (typeof posting === "undefined") {
            return [];
          }
          if (smallest === null || posting.length < smallest.length) {
            smallest = posting;
          }
        }
        documents = smallest.slice();
        for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
          const posting = textIndex.postings.get(tokens[tokenIndex]);
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
          for (let index = 0;index < documents.length; index += 1) {
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
        const included = new Set;
        for (let tokenIndex = 0;tokenIndex < tokens.length; tokenIndex += 1) {
          const posting = textIndex.postings.get(tokens[tokenIndex]);
          if (typeof posting === "undefined") {
            continue;
          }
          for (let index = 0;index < posting.length; index += 1) {
            const document = posting[index];
            if (!included.has(document)) {
              included.add(document);
              documents.push(document);
            }
          }
        }
        documents.sort((left, right) => runtime.order.get(left) - runtime.order.get(right));
      }
      for (let index = 0;index < documents.length; index += 1) {
        documents[index] = cloneValue(documents[index]);
      }
      return documents;
    }
  };
  IluDB.plugify(model);
  return model;
};
var src_default = IluDB;

// src/web.ts
var web_default = src_default;

    const value = module.exports;
    return value && value.__esModule && "default" in value
        ? value.default
        : value;
});
