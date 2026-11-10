import IluDB = require("iludb");
declare const nodeJSON: IluDB.AsyncAdapterFactory & IluDB.PersistenceAdapterErrors;
export as namespace IluDBNodeJSONPlugin;
export = nodeJSON;
