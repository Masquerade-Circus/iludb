import IluDB = require("iludb");
declare const bunJSON: IluDB.AsyncAdapterFactory & IluDB.PersistenceAdapterErrors;
export as namespace IluDBBunJSONPlugin;
export = bunJSON;
