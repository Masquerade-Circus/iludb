import IluDB = require("iludb");

declare function nodeJSONPlugin(IluDB: IluDB.IluDBStatic): void;

declare namespace nodeJSONPlugin {
  class ConflictError extends Error {
    readonly expectedRevision: number;
    readonly actualRevision: number | null;
  }
}

declare module "iludb" {
  interface NodeJSONDatabaseData<TDocument extends object = Document> extends DatabaseData<TDocument> {
    revision: number;
  }

  interface NodeJSONWatchOptions<TDocument extends object = Document> {
    interval?: number;
    onReload?: (database: NodeJSONDatabase<TDocument>) => void;
    onError?: (error: Error) => void;
  }

  interface NodeJSONDatabase<TDocument extends object = Document> extends Database<TDocument> {
    dir: string;
    data: NodeJSONDatabaseData<TDocument>;
    save(): void;
    reload(): void;
    watch(options?: NodeJSONWatchOptions<TDocument>): void;
    unwatch(): void;
  }

  interface IluDBStatic {
    <TDocument extends object = Document>(file: string): NodeJSONDatabase<TDocument>;
    getDatabase<TDocument extends object = Document>(file: string): NodeJSONDatabase<TDocument>;
  }
}

export as namespace IluDBNodeJSONPlugin;
export = nodeJSONPlugin;
