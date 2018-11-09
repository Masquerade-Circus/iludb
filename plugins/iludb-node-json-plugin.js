let fs = require('fs-extra');

function nodeJSONPlugin(IluDB) {
    IluDB.getDatabase = function (file) {
        let Db = {
            dir: file,
            data: {
                collections: {},
                createdAt: new Date(),
                modifiedAt: new Date()
            },
            getCollection(name) {
                return IluDB.getCollection(Db, name);
            },
            save() {
                Db.data.modifiedAt = new Date();
                fs.writeJsonSync(Db.dir, Db.data);
            }
        };

        if (!fs.pathExistsSync(Db.dir)) {
            fs.ensureFileSync(Db.dir);
            fs.writeJsonSync(Db.dir, Db.data);
        }

        Db.data = require(Db.dir);
        IluDB.plugify(Db);
        return Db;
    };
}

module.exports = nodeJSONPlugin;
