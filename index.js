const express = require('express');
const app = express()
require('dotenv').config();
const dns = require('node:dns');
const crypto = require('node:crypto');
const cors = require('cors');
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'grantpilot_ai';
const publicRoles = ['applicant', 'funder'];
const approvalStatuses = ['pending', 'approved', 'rejected'];

if (!uri) {
    throw new Error('MONGODB_URI is required');
}

dns.setServers((process.env.MONGODB_DNS_SERVERS || '8.8.8.8,1.1.1.1')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean));

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

app.use(cors());
app.use(express.json());

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPasswordHash) {
    const [salt, storedHash] = storedPasswordHash.split(':');

    if (!salt || !storedHash) {
        return false;
    }

    const hashBuffer = Buffer.from(storedHash, 'hex');
    const suppliedHashBuffer = crypto.scryptSync(password, salt, 64);

    if (hashBuffer.length !== suppliedHashBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(hashBuffer, suppliedHashBuffer);
}

function getPublicRole(role) {
    return publicRoles.includes(role) ? role : 'applicant';
}

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db(dbName);
        const usersCollection = db.collection('users');
        const sessionsCollection = db.collection('sessions');
        const grantsCollection = db.collection('grants');

        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await sessionsCollection.createIndex({ token: 1 }, { unique: true });
        await grantsCollection.createIndex({ slug: 1 }, { unique: true });

        const verifyToken = async (req, res, next) => {
            const authHeader = req.headers?.authorization;
            const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

            if (!token) {
                return res.status(401).send({ message: 'Unauthorized access' });
            }

            const session = await sessionsCollection.findOne({ token });

            if (!session) {
                return res.status(401).send({ message: 'Unauthorized access' });
            }

            const user = await usersCollection.findOne({ _id: session.userId });

            if (!user) {
                return res.status(401).send({ message: 'Unauthorized access' });
            }

            req.user = user;
            next();
        };

        const verifyAdmin = async (req, res, next) => {
            if (req.user?.role !== 'admin') {
                return res.status(403).send({ message: 'Admin access required' });
            }

            next();
        };

        app.post('/api/users', async (req, res) => {
            try {
                const { name, email, password, organizationName, organizationType, role } = req.body;
                const normalizedEmail = email?.trim().toLowerCase();
                const selectedRole = getPublicRole(role);

                if (!name?.trim() || !normalizedEmail || !password) {
                    return res.status(400).send({ message: 'Name, email, and password are required' });
                }

                if (password.length < 6) {
                    return res.status(400).send({ message: 'Password must be at least 6 characters' });
                }

                const user = {
                    name: name.trim(),
                    email: normalizedEmail,
                    passwordHash: hashPassword(password),
                    role: selectedRole,
                    organizationProfile: {
                        name: organizationName?.trim() || '',
                        type: organizationType?.trim() || '',
                    },
                    preferences: {
                        categories: [],
                        regions: [],
                    },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                const result = await usersCollection.insertOne(user);
                const token = crypto.randomBytes(32).toString('hex');

                await sessionsCollection.insertOne({
                    token,
                    userId: result.insertedId,
                    createdAt: new Date(),
                });

                res.status(201).send({
                    insertedId: result.insertedId,
                    token,
                    user: {
                        id: result.insertedId,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                        organizationProfile: user.organizationProfile,
                    },
                });
            } catch (error) {
                if (error.code === 11000) {
                    return res.status(409).send({ message: 'An account with this email already exists' });
                }

                res.status(500).send({ message: 'Failed to create account' });
            }
        });

        app.post('/api/login', async (req, res) => {
            try {
                const { email, password } = req.body;
                const normalizedEmail = email?.trim().toLowerCase();

                if (!normalizedEmail || !password) {
                    return res.status(400).send({ message: 'Email and password are required' });
                }

                const user = await usersCollection.findOne({ email: normalizedEmail });

                if (!user || !verifyPassword(password, user.passwordHash || '')) {
                    return res.status(401).send({ message: 'Invalid email or password' });
                }

                const token = crypto.randomBytes(32).toString('hex');

                await sessionsCollection.insertOne({
                    token,
                    userId: user._id,
                    createdAt: new Date(),
                });

                res.send({
                    message: 'Login successful',
                    token,
                    user: {
                        id: user._id,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                        organizationProfile: user.organizationProfile,
                    },
                });
            } catch (error) {
                res.status(500).send({ message: 'Failed to sign in' });
            }
        });

        app.get('/api/grants', async (req, res) => {
            const query = { approvalStatus: 'approved' };

            if (req.query.search) {
                query.$or = [
                    { title: { $regex: req.query.search, $options: 'i' } },
                    { funder: { $regex: req.query.search, $options: 'i' } },
                    { category: { $regex: req.query.search, $options: 'i' } },
                    { summary: { $regex: req.query.search, $options: 'i' } },
                ];
            }

            if (req.query.category && req.query.category !== 'All') {
                query.category = req.query.category;
            }

            const sort = {};
            if (req.query.sort === 'Deadline') {
                sort.deadline = 1;
            } else if (req.query.sort === 'Funding') {
                sort.maxAmount = -1;
            } else {
                sort.match = -1;
            }

            const grants = await grantsCollection.find(query).sort(sort).toArray();
            res.send(grants);
        });

        app.get('/api/grants/:slug', async (req, res) => {
            const grant = await grantsCollection.findOne({
                slug: req.params.slug,
                approvalStatus: 'approved',
            });

            if (!grant) {
                return res.status(404).send({ message: 'Grant not found or not approved' });
            }

            res.send(grant);
        });

        app.get('/api/admin/grants', verifyToken, verifyAdmin, async (req, res) => {
            const grants = await grantsCollection.find().sort({ updatedAt: -1 }).toArray();
            res.send(grants);
        });

        app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
            const [totalGrants, approvedGrants, pendingGrants, rejectedGrants, usersByRole] = await Promise.all([
                grantsCollection.countDocuments(),
                grantsCollection.countDocuments({ approvalStatus: 'approved' }),
                grantsCollection.countDocuments({
                    $or: [{ approvalStatus: 'pending' }, { approvalStatus: { $exists: false } }],
                }),
                grantsCollection.countDocuments({ approvalStatus: 'rejected' }),
                usersCollection.aggregate([
                    {
                        $group: {
                            _id: '$role',
                            count: { $sum: 1 },
                        },
                    },
                ]).toArray(),
            ]);

            res.send({
                grants: {
                    total: totalGrants,
                    approved: approvedGrants,
                    pending: pendingGrants,
                    rejected: rejectedGrants,
                },
                usersByRole,
            });
        });

        app.get('/api/my/grants', verifyToken, async (req, res) => {
            if (!['funder', 'admin'].includes(req.user?.role)) {
                return res.status(403).send({ message: 'Funder access required' });
            }

            const grants = await grantsCollection.find({ createdBy: req.user._id }).sort({ updatedAt: -1 }).toArray();
            res.send(grants);
        });

        app.patch('/api/admin/grants/:id/approval', verifyToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const { approvalStatus } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'Invalid grant id' });
            }

            if (!approvalStatuses.includes(approvalStatus)) {
                return res.status(400).send({ message: 'Invalid approval status' });
            }

            const update = {
                $set: {
                    approvalStatus,
                    approvedBy: approvalStatus === 'approved' ? req.user._id : null,
                    approvedAt: approvalStatus === 'approved' ? new Date() : null,
                    updatedAt: new Date(),
                },
            };

            const result = await grantsCollection.updateOne({ _id: new ObjectId(id) }, update);

            if (result.matchedCount === 0) {
                return res.status(404).send({ message: 'Grant not found' });
            }

            const grant = await grantsCollection.findOne({ _id: new ObjectId(id) });
            res.send({ message: 'Grant approval updated', grant });
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        //await client.close();
    }
}

app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

run().catch(console.dir);
