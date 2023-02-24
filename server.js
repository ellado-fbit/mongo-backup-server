const express = require('express')
const { MongoClient, ObjectID } = require('mongodb')
const { mongoFind, mongoFindOne } = require('@fundaciobit/express-redis-mongo')
const fs = require('fs')
const path = require('path')
const moment = require('moment')
const dotenv = require('dotenv')
dotenv.config()

const mongodbUri = process.env.MONGODB_URI
const backups_base_dir = path.join(__dirname, 'backups')

if (!fs.existsSync(backups_base_dir)) fs.mkdirSync(backups_base_dir)

// Open MongoDB connection
MongoClient.connect(mongodbUri, { useUnifiedTopology: true, poolSize: 10 })
  .then(client => {
    createApp(client)
  })
  .catch(err => {
    console.log(err.message)
    process.exit(1)
  })

const createApp = (mongoClient) => {
  const app = express()
  const port = 3000

  app.use(express.static(path.join(__dirname, 'backups')))

  // List databases
  app.get('/list-databases', (req, res) => {
    mongoClient.db().admin().listDatabases()
      .then(dbs => {
        let databases = dbs.databases.filter(db => db.name !== 'admin' && db.name !== 'local').map(db => db.name)
        databases = databases.map(db => ({ database: db, 'list-collections': `http://localhost:${port}/list-collections/db/${db}` }))
        res.status(200).json({ databases })
      })
  })

  // List collections
  app.get('/list-collections/db/:db',
    (req, res, next) => {
      mongoClient.db(req.params.db).listCollections().toArray()
        .then(cols => {
          const collections = cols.map(col => ({
            collection: col.name,
            // 'list-complete-items': `http://localhost:${port}/read-col/db/${req.params.db}/col/${col.name}/itemsmode/complete`,
            // 'list-summary-items': `http://localhost:${port}/read-col/db/${req.params.db}/col/${col.name}/itemsmode/summary`,
            'backups': fs.existsSync(path.join(backups_base_dir, `${req.params.db}-${col.name}`)) ? fs.readdirSync(path.join(backups_base_dir, `${req.params.db}-${col.name}`)).map(x => `http://localhost:${port}/${req.params.db}-${col.name}/${x}`) : [],
            'click-to-backup': `http://localhost:${port}/create-backup/db/${req.params.db}/col/${col.name}`,
            'click-to-upload-to-local-mongo': `http://localhost:${port}/upload-to-local-mongodb/db/${req.params.db}/col/${col.name}/file/${req.params.db}-${col.name}-YYYY-MM-DD.json`
          }))
          res.status(200).json({ collections })
        })
        .catch(error => {
          next(error)
        })
    })

  // Read item
  app.get('/read-item/db/:db/col/:col/id/:id',
    (req, res, next) => {
      mongoFindOne({ mongoClient, db: req.params.db, collection: req.params.col, query: (req) => ({ _id: new ObjectID(req.params.id) }) })(req, res, (err) => {
        if (err) {
          next(err)
        } else {
          next()
        }
      })
    },
    (req, res) => {
      const { result } = res.locals
      if (result) return res.status(200).json(result)
      res.status(404).send('Document not found')
    })

  // Read collection
  app.get('/read-col/db/:db/col/:col/itemsmode/:itemsmode',
    (req, res, next) => {
      if (req.params.itemsmode === 'summary') {
        req.mongoProjection = { creation_date: 1, title: 1 }
      } else {
        req.mongoProjection = {}
      }
      next()
    },
    (req, res, next) => {
      // eslint-disable-next-line no-unused-vars
      mongoFind({ mongoClient, db: req.params.db, collection: req.params.col, query: (req) => ({}), projection: req.mongoProjection, sort: { _id: -1 } })(req, res, (err) => {
        if (err) {
          next(err)
        } else {
          next()
        }
      })
    },
    (req, res) => {
      let { results } = res.locals
      if (req.params.itemsmode === 'summary') {
        results = results.map(item => ({ creation_date: item.creation_date, title: item.title, item: `http://localhost:${port}/read-item/db/${req.params.db}/col/${req.params.col}/id/${item._id}` }))
      }
      res.status(200).json({ total: results.length, items: results })
    })

  // Create collection backup
  app.get('/create-backup/db/:db/col/:col',
    (req, res, next) => {
      // eslint-disable-next-line no-unused-vars
      mongoFind({ mongoClient, db: req.params.db, collection: req.params.col, query: (req) => ({}), sort: { _id: -1 } })(req, res, (err) => {
        if (err) {
          next(err)
        } else {
          next()
        }
      })
    },
    (req, res) => {
      let { results } = res.locals
      const backups_col_dir = `${backups_base_dir}/${req.params.db}-${req.params.col}`
      if (!fs.existsSync(backups_col_dir)) fs.mkdirSync(backups_col_dir)
      const today = moment().format('YYYY-MM-DD')
      fs.writeFileSync(`${backups_col_dir}/${req.params.db}-${req.params.col}-${today}.json`, JSON.stringify(results, null, 2), 'utf8')
      res.status(200).json({
        ok: 'Backup successfully created',
        'list-collections': `http://localhost:${port}/list-collections/db/${req.params.db}`
      })
    })

  // Upload collection to local MongoDB
  app.get('/upload-to-local-mongodb/db/:db/col/:col/file/:file',
    (req, res, next) => {
      MongoClient.connect('mongodb://127.0.0.1:27017', { useUnifiedTopology: true })
      .then(client => {
        req.localMongoClient = client
        next()
      })
      .catch(err => {
        next(err)
      })
    },
    (req, res, next) => {
      const jsonPath = path.join(__dirname, 'backups', `${req.params.db}-${req.params.col}`, `${req.params.file}`)
      try {
        const content = fs.readFileSync(jsonPath, 'utf8')
        res.locals.results = JSON.parse(content)
        res.locals.results.forEach(item => item._id = new ObjectID(item._id))
        next()
      } catch(error) {
        next(error)
      }
    },
    (req, res, next) => {
      req.localMongoClient.db(req.params.db).collection(req.params.col).insertMany(res.locals.results)
        .then(result => {
          res.status(200).send(`Successfully inserted ${result.insertedCount} items. Remember to create indexes!`)
        })
        .catch(err => {
          next(err)
        })
    })

  // Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({ mongodbUri, 'list-databases': `http://localhost:${port}/list-databases` })
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (!err.statusCode) err.statusCode = 500
    res.status(err.statusCode).send(err.toString())
  })

  app.listen(port, () => { console.log(`Server running on port http://localhost:${port} ...`) })
}
