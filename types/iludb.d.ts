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
    <TDocument extends object = Document>(): Database<TDocument>;
    plugify<TTarget extends object>(object: TTarget): void;
    use<TArguments extends unknown[]>(plugin: Plugin<this, TArguments>, ...args: TArguments): this;
    getDatabase<TDocument extends object = Document>(): Database<TDocument>;
    getCollection<TDocument extends object>(database: Database<TDocument>, name: string): Collection<TDocument>;
  }
}

export as namespace IluDB;
export = IluDB;
