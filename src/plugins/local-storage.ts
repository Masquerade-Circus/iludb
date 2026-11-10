import { checkRevision, ConflictError, PersistenceError, type Adapter } from "../persistence";

// Sessions in this document share notifications. Native storage events cover other documents.
const sessions = new Map<string, Set<() => void>>();

const localStorageAdapter = {
  ConflictError,
  PersistenceError,
  open(key: string): Adapter {
    let storage: Storage;
    try {
      storage = window.localStorage;
    } catch (cause) {
      throw new PersistenceError("IO", "Browser storage is unavailable.", { cause });
    }
    let notify: (() => void) | null = null;
    return {
      read(): string | null {
        try {
          return storage.getItem(key);
        } catch (cause) {
          throw new PersistenceError("IO", "Could not read browser storage.", { cause });
        }
      },
      write(input): void {
        try {
          checkRevision({ serialized: storage.getItem(key), expectedRevision: input.expectedRevision });
          storage.setItem(key, input.serialized);
        } catch (cause) {
          throw cause instanceof PersistenceError
            ? cause
            : new PersistenceError("IO", "Could not write browser storage.", { cause });
        }
        for (const callback of [...(sessions.get(key) ?? [])]) {
          if (callback !== notify) {
            callback();
          }
        }
      },
      subscribe(onChange): () => void {
        notify = onChange;
        const listeners = sessions.get(key) ?? new Set();
        sessions.set(key, listeners);
        listeners.add(onChange);
        const listener = (event: StorageEvent): void => {
          if (event.storageArea === storage && (event.key === key || event.key === null)) {
            onChange();
          }
        };
        window.addEventListener("storage", listener);
        return () => {
          window.removeEventListener("storage", listener);
          listeners.delete(onChange);
          if (listeners.size === 0) {
            sessions.delete(key);
          }
          notify = null;
        };
      }
    };
  }
};

export default localStorageAdapter;
