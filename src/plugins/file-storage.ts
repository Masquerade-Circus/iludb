import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  writeSync,
  fstatSync,
  lstatSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  renameSync,
  unlinkSync,
  watchFile,
  unwatchFile
} from "node:fs";
import { open, lstat, mkdir, link, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { checkRevision, PersistenceError, type AsyncAdapter, type WriteSnapshot } from "../persistence";

function signature(stats: any): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function io(cause: any): never {
  throw cause instanceof PersistenceError
    ? cause
    : new PersistenceError("IO", "Snapshot filesystem operation failed.", { cause });
}

export function fileAdapter(native: typeof Bun | null = null): {
  asynchronous: true;
  open(destination: string): AsyncAdapter;
} {
  return {
    asynchronous: true,
    open(destination: string): AsyncAdapter {
      const file = resolve(destination);
      function read(): string | null {
        let descriptor: number;
        try {
          descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (cause: any) {
          if (cause.code === "ENOENT") {
            return null;
          }
          return io(cause);
        }
        try {
          const before = fstatSync(descriptor);
          if (!before.isFile()) {
            throw new Error("Expected regular file");
          }
          const serialized = readFileSync(descriptor, "utf8");
          const after = fstatSync(descriptor);
          const current = lstatSync(file);
          if (!current.isFile() || signature(before) !== signature(after) || signature(after) !== signature(current)) {
            throw new Error("Snapshot changed during reading");
          }
          return serialized;
        } catch (cause) {
          return io(cause);
        } finally {
          closeSync(descriptor);
        }
      }

      async function asyncRead(): Promise<string | null> {
        let descriptor;
        try {
          descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (cause: any) {
          if (cause.code === "ENOENT") {
            return null;
          }
          return io(cause);
        }
        try {
          const before = await descriptor.stat();
          if (!before.isFile()) {
            throw new Error("Expected regular file");
          }
          const serialized =
            native === null ? await descriptor.readFile("utf8") : await native.file(descriptor.fd).text();
          const after = await descriptor.stat();
          const current = await lstat(file);
          if (!current.isFile() || signature(before) !== signature(after) || signature(after) !== signature(current)) {
            throw new Error("Snapshot changed during reading");
          }
          return serialized;
        } catch (cause) {
          return io(cause);
        } finally {
          await descriptor.close();
        }
      }

      return {
        read,
        asyncRead,
        write(input: WriteSnapshot): void {
          const temporary = `${file}.tmp-${randomUUID()}`;
          let descriptor: number | null = null;
          let created = false;
          let published = false;
          let failure: unknown = null;
          try {
            checkRevision({ serialized: read(), expectedRevision: input.expectedRevision });
            const mode = input.expectedRevision === null ? 0o600 : lstatSync(file).mode & 0o7777;
            if (input.expectedRevision === null) {
              mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            }
            descriptor = openSync(temporary, "wx", 0o600);
            created = true;
            const bytes = Buffer.from(input.serialized);
            let offset = 0;
            while (offset < bytes.length) {
              const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
              if (count <= 0) {
                throw new Error("Incomplete write");
              }
              offset += count;
            }
            fchmodSync(descriptor, mode);
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = null;
            if (input.expectedRevision === null) {
              linkSync(temporary, file);
            } else {
              renameSync(temporary, file);
            }
            published = true;
          } catch (cause) {
            failure = cause;
          } finally {
            if (descriptor !== null) {
              try {
                closeSync(descriptor);
              } catch (cause) {
                failure = failure === null ? cause : new AggregateError([failure, cause]);
              }
            }
            if (created && (!published || input.expectedRevision === null)) {
              try {
                unlinkSync(temporary);
              } catch (cause) {
                if (!published) {
                  failure = failure === null ? cause : new AggregateError([failure, cause]);
                } else {
                  process.emitWarning("Committed snapshot temporary cleanup failed.");
                }
              }
            }
          }
          if (failure !== null) {
            io(failure);
          }
        },
        async asyncWrite(input: WriteSnapshot): Promise<void> {
          const temporary = `${file}.tmp-${randomUUID()}`;
          let descriptor: Awaited<ReturnType<typeof open>> | null = null;
          let created = false;
          let published = false;
          let failure: unknown = null;
          try {
            checkRevision({ serialized: await asyncRead(), expectedRevision: input.expectedRevision });
            const mode = input.expectedRevision === null ? 0o600 : (await lstat(file)).mode & 0o7777;
            if (input.expectedRevision === null) {
              await mkdir(dirname(file), { recursive: true, mode: 0o700 });
            }
            descriptor = await open(temporary, "wx", 0o600);
            created = true;
            const bytes = Buffer.from(input.serialized);
            if (native === null) {
              await descriptor.writeFile(bytes);
            } else if ((await native.write(native.file(descriptor.fd), bytes)) !== bytes.length) {
              throw new Error("Incomplete write");
            }
            await descriptor.chmod(mode);
            await descriptor.sync();
            await descriptor.close();
            descriptor = null;
            if (input.expectedRevision === null) {
              await link(temporary, file);
            } else {
              await rename(temporary, file);
            }
            published = true;
          } catch (cause) {
            failure = cause;
          } finally {
            if (descriptor !== null) {
              try {
                await descriptor.close();
              } catch (cause) {
                failure = failure === null ? cause : new AggregateError([failure, cause]);
              }
            }
            if (created && (!published || input.expectedRevision === null)) {
              try {
                if (native === null) {
                  await unlink(temporary);
                } else {
                  await native.file(temporary).delete();
                }
              } catch (cause) {
                if (!published) {
                  failure = failure === null ? cause : new AggregateError([failure, cause]);
                } else {
                  process.emitWarning("Committed snapshot temporary cleanup failed.");
                }
              }
            }
          }
          if (failure !== null) {
            io(failure);
          }
        },
        subscribe(onChange, options): () => void {
          const listener = (): void => onChange();
          watchFile(file, { interval: options.interval, persistent: false }, listener);
          return () => unwatchFile(file, listener);
        }
      };
    }
  };
}
