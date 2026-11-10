declare const IluDB: IluDB.IluDBStatic;

declare namespace IluDB {
  type Document = Record<string, unknown>;

  interface DocumentMetadata {
    $id: number;
    $createdAt: Date;
    $modifiedAt: Date;
  }

  type StoredDocument<TDocument extends object = Document> = TDocument & DocumentMetadata;

  type DataDocument<TDocument extends object = Document> = TDocument & Partial<DocumentMetadata>;

  type NewDocument<TDocument extends object = Document> = TDocument & {
    $id?: never;
    $createdAt?: never;
    $modifiedAt?: never;
  };

  type UpdateDocument<TDocument extends object = Document> = Partial<TDocument> & {
    $id: number;
    $createdAt?: Date;
    $modifiedAt?: Date;
  };

  type Query<TDocument extends object = Document> = Partial<StoredDocument<TDocument>>;

  type SortOptions<TDocument extends object = Document> = Partial<
    Record<Extract<keyof StoredDocument<TDocument>, string>, 1 | -1>
  >;

  interface FindOptions<TDocument extends object = Document> {
    sort?: SortOptions<TDocument>;
  }

  interface IndexDefinition<TDocument extends object = Document> {
    name: string;
    fields: Array<Extract<keyof StoredDocument<TDocument>, string>>;
  }

  interface TextSearchOptions {
    operator?: "AND" | "OR";
  }

  type Plugin<TTarget = unknown, TArguments extends unknown[] = unknown[]> = (
    target: TTarget,
    ...args: TArguments
  ) => void;

  interface CollectionData<TDocument extends object = Document> {
    data: Array<DataDocument<TDocument>>;
    index: number;
    createdAt: Date;
    modifiedAt: Date;
  }

  interface DatabaseData<TDocument extends object = Document> {
    collections: Record<string, CollectionData<TDocument>>;
    createdAt: Date;
    modifiedAt: Date;
  }

  interface Collection<TDocument extends object = Document> {
    sort(array: Array<StoredDocument<TDocument>>, options?: SortOptions<TDocument>): Array<StoredDocument<TDocument>>;
    find(query?: Query<TDocument>, options?: FindOptions<TDocument>): Array<StoredDocument<TDocument>>;
    findOne(query?: Query<TDocument>, options?: FindOptions<TDocument>): StoredDocument<TDocument> | undefined;
    get(id: number): StoredDocument<TDocument> | undefined;
    update(document: UpdateDocument<TDocument>): StoredDocument<TDocument>;
    count(query?: Query<TDocument>): number;
    add(document: NewDocument<TDocument>): StoredDocument<TDocument> | undefined;
    remove(document: Pick<DocumentMetadata, "$id">): void;
    createIndex(
      name: string,
      fields: Extract<keyof StoredDocument<TDocument>, string> | Array<Extract<keyof StoredDocument<TDocument>, string>>
    ): Collection<TDocument>;
    getIndexes(): Array<IndexDefinition<TDocument>>;
    dropIndex(name: string): boolean;
    createTextIndex(
      name: string,
      fields: Extract<keyof StoredDocument<TDocument>, string> | Array<Extract<keyof StoredDocument<TDocument>, string>>
    ): Collection<TDocument>;
    getTextIndexes(): Array<IndexDefinition<TDocument>>;
    dropTextIndex(name: string): boolean;
    searchText(name: string, text: string, options?: TextSearchOptions): Array<StoredDocument<TDocument>>;
    reindex(): Collection<TDocument>;
    use<TArguments extends unknown[]>(plugin: Plugin<this, TArguments>, ...args: TArguments): this;
  }

  interface Database<TDocument extends object = Document> {
    data: DatabaseData<TDocument>;
    getCollection<TCollection extends object = TDocument>(name: string): Collection<TCollection>;
    save(): void;
    use<TArguments extends unknown[]>(plugin: Plugin<this, TArguments>, ...args: TArguments): this;
  }

  interface IluDBStatic {
    <TDocument extends object = Document>(options: { adapter: AsyncAdapterFactory }): AsyncDatabase<TDocument>;
    <TDocument extends object = Document>(options: { adapter: AdapterFactory }): SyncDatabase<TDocument>;
    <TDocument extends object = Document>(): Database<TDocument>;
    plugify<TTarget extends object>(object: TTarget): void;
    use<TArguments extends unknown[]>(plugin: Plugin<this, TArguments>, ...args: TArguments): this;
    getDatabase<TDocument extends object = Document>(): Database<TDocument>;
    getCollection<TDocument extends object>(database: Database<TDocument>, name: string): Collection<TDocument>;
  }

  type PersistenceErrorCode = "INVALID_INPUT" | "INVALID_SNAPSHOT" | "CONFLICT" | "IO" | "CLOSED" | "BUSY";
  interface PersistenceError extends Error {
    readonly code: PersistenceErrorCode;
  }
  interface ConflictError extends PersistenceError {
    readonly expectedRevision: number;
    readonly actualRevision: number | null;
  }
  interface WriteSnapshot {
    serialized: string;
    expectedRevision: number | null;
  }
  interface Adapter {
    read(): string | null;
    write(input: WriteSnapshot): void;
    subscribe(onChange: () => void, options: { interval: number }): () => void;
  }
  interface AsyncAdapter extends Adapter {
    asyncRead(): Promise<string | null>;
    asyncWrite(input: WriteSnapshot): Promise<void>;
  }
  interface AdapterFactory {
    open(destination: string): Adapter;
  }
  interface AsyncAdapterFactory extends AdapterFactory {
    readonly asynchronous: true;
    open(destination: string): AsyncAdapter;
  }
  interface PersistenceAdapterErrors {
    PersistenceError: new (code: PersistenceErrorCode, message: string, options?: ErrorOptions) => PersistenceError;
    ConflictError: new (expectedRevision: number, actualRevision: number | null) => ConflictError;
  }
  interface Snapshot<TDocument extends object = Document> extends DatabaseData<TDocument> {
    revision: number;
  }
  interface PersistentCollection<TDocument extends object = Document> extends Omit<
    Collection<TDocument>,
    "add" | "get" | "findOne" | "createIndex" | "createTextIndex" | "reindex" | "use"
  > {
    add(document: NewDocument<TDocument>): StoredDocument<TDocument>;
    get(id: number): StoredDocument<TDocument> | null;
    findOne(query?: Query<TDocument>, options?: FindOptions<TDocument>): StoredDocument<TDocument> | null;
    createIndex(
      name: string,
      fields: Extract<keyof StoredDocument<TDocument>, string> | Array<Extract<keyof StoredDocument<TDocument>, string>>
    ): this;
    createTextIndex(
      name: string,
      fields: Extract<keyof StoredDocument<TDocument>, string> | Array<Extract<keyof StoredDocument<TDocument>, string>>
    ): this;
    reindex(): this;
    use<TArguments extends unknown[]>(plugin: Plugin<this, TArguments>, ...args: TArguments): this;
  }
  interface AsyncCollection<TDocument extends object = Document> {
    add(document: NewDocument<TDocument>): Promise<StoredDocument<TDocument>>;
    update(document: UpdateDocument<TDocument>): Promise<StoredDocument<TDocument>>;
    remove(document: Pick<DocumentMetadata, "$id">): Promise<void>;
    get(id: number): Promise<StoredDocument<TDocument> | null>;
    find(query?: Query<TDocument>, options?: FindOptions<TDocument>): Promise<Array<StoredDocument<TDocument>>>;
    findOne(query?: Query<TDocument>, options?: FindOptions<TDocument>): Promise<StoredDocument<TDocument> | null>;
    count(query?: Query<TDocument>): Promise<number>;
    sort(
      array: Array<StoredDocument<TDocument>>,
      options?: SortOptions<TDocument>
    ): Promise<Array<StoredDocument<TDocument>>>;
    createIndex(
      name: string,
      fields: Extract<keyof StoredDocument<TDocument>, string> | Array<Extract<keyof StoredDocument<TDocument>, string>>
    ): Promise<this>;
    getIndexes(): Promise<Array<IndexDefinition<TDocument>>>;
    dropIndex(name: string): Promise<boolean>;
    createTextIndex(
      name: string,
      fields: Extract<keyof StoredDocument<TDocument>, string> | Array<Extract<keyof StoredDocument<TDocument>, string>>
    ): Promise<this>;
    getTextIndexes(): Promise<Array<IndexDefinition<TDocument>>>;
    dropTextIndex(name: string): Promise<boolean>;
    searchText(name: string, text: string, options?: TextSearchOptions): Promise<Array<StoredDocument<TDocument>>>;
    reindex(): Promise<this>;
    use<TArguments extends unknown[]>(plugin: Plugin<this, TArguments>, ...args: TArguments): Promise<this>;
  }
  interface TransactionDatabase<TDocument extends object = Document> {
    getCollection<TCollection extends object = TDocument>(name: string): PersistentCollection<TCollection>;
  }
  interface WatchOptions<TDatabase> {
    interval?: number;
    onReload?: (database: TDatabase) => void;
    onError?: (error: Error) => void;
  }
  interface SyncDatabase<TDocument extends object = Document> extends TransactionDatabase<TDocument> {
    load(destination: string): void;
    save(): void;
    reload(): void;
    transaction<TResult>(
      mutate: (tx: TransactionDatabase<TDocument>) => TResult extends PromiseLike<unknown> ? never : TResult
    ): TResult;
    snapshot(): Snapshot<TDocument>;
    watch(options?: WatchOptions<this>): void;
    unwatch(): void;
    close(): void;
  }
  interface AsyncDatabase<TDocument extends object = Document> extends SyncDatabase<TDocument> {
    asyncLoad(destination: string): Promise<void>;
    asyncSave(): Promise<void>;
    asyncReload(): Promise<void>;
    asyncTransaction<TResult>(
      mutate: (tx: TransactionDatabase<TDocument>) => TResult extends PromiseLike<unknown> ? never : TResult
    ): Promise<TResult>;
    asyncSnapshot(): Promise<Snapshot<TDocument>>;
    getAsyncCollection<TCollection extends object = TDocument>(name: string): AsyncCollection<TCollection>;
    asyncClose(): Promise<void>;
  }
}

export as namespace IluDB;
export = IluDB;
