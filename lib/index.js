
import isUndefined from 'lodash/isUndefined';
import filter from 'lodash/filter';
import find from 'lodash/find';
import orderBy from 'lodash/orderBy';
import size from 'lodash/size';
import findIndex from 'lodash/findIndex';
import cloneDeep from 'lodash/cloneDeep';
import remove from 'lodash/remove';
import includes from 'lodash/includes';

function IluDB(...args) {
    return IluDB.getDatabase(...args);
};
IluDB.plugify = function (object) {
    let plugins = [];
    object.use = function (plugin, ...args) {
        if (plugins.indexOf(plugin) === -1) {
            plugin(object, ...args);
            plugins.push(plugin);
        }
        return object;
    };
};
IluDB.plugify(IluDB);


IluDB.getDatabase = function () {
    let Db = {
        data: {
            collections: {},
            createdAt: new Date(),
            modifiedAt: new Date()
        },
        getCollection(name) {
            return IluDB.getCollection(Db, name);
        },
        save() {}
    };
    IluDB.plugify(Db);
    return Db;
};

IluDB.getCollection = function (Db, name) {
    if (isUndefined(Db.data.collections[name])) {
        Db.data.collections[name] = {
            data: [],
            index: 0,
            createdAt: new Date(),
            modifiedAt: new Date()
        };
    }
    let collection = Db.data.collections[name];

    let Model = {
        sort(array, options = {}) {
            let data = array;
            if (Object.keys(options).length > 0) {
                let sort = Object.assign({}, options);
                for (let i in sort) {
                    sort[i] = sort[i] === 1 ? 'asc' : 'desc';
                }
                data = orderBy(data, Object.keys(sort), Object.values(sort));
            }
            return data;
        },
        find(query = {}, options = {}) {
            let data = filter(collection.data, query);
            data = Model.sort(data, options.sort);
            return data.map(document => cloneDeep(document));
        },
        findOne(query = {}, options = {}) {
            let data = collection.data;
            data = Model.sort(data, options.sort);
            return cloneDeep(find(data, query));
        },
        get(id) {
            return Model.findOne({$id: id});
        },
        add(document) {
            if (typeof document === 'object' && !Array.isArray(document) && document !== null) {
                if (!isUndefined(document.$id)) {
                    throw new Error('The $id property is reserved.');
                }
                if (!isUndefined(document.$createdAt)) {
                    throw new Error('The $createdAt property is reserved.');
                }
                if (!isUndefined(document.$updatedAt)) {
                    throw new Error('The $updatedAt property is reserved.');
                }

                collection.index += 1;
                document.$id = collection.index;
                document.$createdAt = new Date();
                document.$modifiedAt = new Date();
                collection.data.push(document);
                collection.modifiedAt = new Date();
                Db.save();
                return cloneDeep(document);
            }
        },
        update(document) {
            let index = findIndex(collection.data, {$id: document.$id});
            if (index === -1) {
                throw new Error('The document does not exists.');
            }

            for (let i in document) {
                if (!includes(['$id', '$createdAt', '$modifiedAt'], i)) {
                    collection.data[index][i] = document[i];
                }
            }

            collection.data[index].$modifiedAt = new Date();
            collection.modifiedAt = new Date();
            Db.save();
            return cloneDeep(collection.data[index]);
        },
        remove(document) {
            let doc = Model.findOne({$id: document.$id});
            if (isUndefined(doc)) {
                throw new Error('The document does not exists.');
            }
            remove(collection.data, {$id: document.$id});
            collection.modifiedAt = new Date();
            Db.save();
        },
        count(query = {}) {
            return size(Model.find(query));
        }
    };

    IluDB.plugify(Model);

    return Model;
};

export default IluDB;
