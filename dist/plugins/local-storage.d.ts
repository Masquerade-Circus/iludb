import IluDB = require("iludb");
declare const localStorageAdapter: IluDB.AdapterFactory & IluDB.PersistenceAdapterErrors;
export as namespace IluDBLocalStorageAdapter;
export = localStorageAdapter;
