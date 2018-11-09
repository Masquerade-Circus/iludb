const expect = require('expect');
const IluDb = require('../dist/iludb.min');

describe('Database', () => {
    let db;

    beforeEach(() => {
        db = IluDb('test');
    });

    it('Should load a database', () => {
        expect(db).toEqual(expect.objectContaining({
            data: {
                collections: {},
                createdAt: expect.any(Date),
                modifiedAt: expect.any(Date)
            },
            getCollection: expect.any(Function),
            save: expect.any(Function),
            use: expect.any(Function)
        }));
    });

    it('Should create a collection when first try to get if does not exists', () => {
        // No collections
        expect(db).toEqual(expect.objectContaining({
            data: expect.objectContaining({
                collections: {}
            })
        }));

        // Create collection if does not exists
        db.getCollection('test');

        // Must have the new collection
        expect(db).toEqual(expect.objectContaining({
            data: expect.objectContaining({
                collections: {
                    test: {
                        data: [],
                        index: 0,
                        createdAt: expect.any(Date),
                        modifiedAt: expect.any(Date)
                    }
                }
            })
        }));
    });

    it('Should test must to have methods of a returned collection', () => {
        let collection = db.getCollection('test');

        expect(collection).toEqual({
            sort: expect.any(Function),
            find: expect.any(Function),
            findOne: expect.any(Function),
            get: expect.any(Function),
            add: expect.any(Function),
            update: expect.any(Function),
            remove: expect.any(Function),
            count: expect.any(Function),
            use: expect.any(Function)
        });
    });

    it('Should add a document to a collection', () => {
        let collection = db.getCollection('test');
        let expected = {
            firstName: 'John',
            lastName: 'Doe',
            $id: 1,
            $createdAt: expect.any(Date),
            $modifiedAt: expect.any(Date)
        };

        let result = collection.add({firstName: 'John', lastName: 'Doe'});
        expect(result).toEqual(expected);
        expect(db.data.collections.test.data).toEqual([expected]);
    });

    it('Should get a document by id', () => {
        let collection = db.getCollection('test');
        let expected = {
            firstName: 'John',
            lastName: 'Doe',
            $id: 1,
            $createdAt: expect.any(Date),
            $modifiedAt: expect.any(Date)
        };

        collection.add({firstName: 'John', lastName: 'Doe'});
        let result = collection.get(expected.$id);
        expect(result).toEqual(expected);
    });

    it('Should findOne method to find a document for a single element', () => {
        let collection = db.getCollection('test');
        let expected = {
            firstName: 'John',
            lastName: 'Doe',
            $id: 1,
            $createdAt: expect.any(Date),
            $modifiedAt: expect.any(Date)
        };

        collection.add({firstName: 'John', lastName: 'Doe'});
        let result = collection.findOne({firstName: 'John'});
        expect(result).toEqual(expected);
    });

    it('Should find method to find a  set of documents', () => {
        let collection = db.getCollection('test');
        let expected = [
            {
                firstName: 'John 2',
                lastName: 'Doe 2',
                $id: 2,
                $createdAt: expect.any(Date),
                $modifiedAt: expect.any(Date)
            }
        ];

        collection.add({firstName: 'John', lastName: 'Doe'});
        collection.add({firstName: 'John 2', lastName: 'Doe 2'});
        collection.add({firstName: 'John 3', lastName: 'Doe 3'});
        let result = collection.find({firstName: 'John 2'});

        expect(result).toEqual(expected);
    });
});
