const express = require('express');
const app = express()
require('dotenv').config({ override: true });
const dns = require('node:dns');
const crypto = require('node:crypto');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'grantpilot_ai';
const publicRoles = ['applicant', 'funder'];
const approvalStatuses = ['pending', 'approved', 'rejected'];
const funderApprovalStatuses = ['pending', 'approved', 'rejected'];
const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
const supportedDocumentTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
];

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

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 8 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (supportedDocumentTypes.includes(file.mimetype)) {
            cb(null, true);
            return;
        }

        cb(new Error('Only PDF, DOCX, and TXT files are supported'));
    },
});

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

function getFunderApprovalStatus(role, approvalStatus) {
    if (role !== 'funder') {
        return 'approved';
    }

    return funderApprovalStatuses.includes(approvalStatus) ? approvalStatus : 'pending';
}

function serializeUser(user) {
    return {
        id: user._id?.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        funderApprovalStatus: getFunderApprovalStatus(user.role, user.funderApprovalStatus),
        organizationProfile: user.organizationProfile || {
            name: '',
            type: '',
        },
    };
}

function extractGeminiText(response) {
    return (response.candidates || [])
        .flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => part.text || '')
        .join('')
        .trim();
}

function buildGeminiPrompt(input, wantsJson) {
    const systemInstruction = input
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
    const prompt = input
        .filter((message) => message.role !== 'system')
        .map((message) => `${message.role || 'user'}: ${message.content}`)
        .join('\n\n');

    return {
        systemInstruction,
        prompt: wantsJson
            ? `${prompt}\n\nReturn only valid JSON. Do not include markdown fences or commentary.`
            : prompt,
    };
}

async function callGemini({ input, text, maxOutputTokens = 1200 }) {
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

    if (!geminiApiKey) {
        const error = new Error('GEMINI_API_KEY is not configured');
        error.statusCode = 503;
        throw error;
    }

    const wantsJson = text?.format?.type === 'json_schema';
    const { systemInstruction, prompt } = buildGeminiPrompt(input, wantsJson);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
        method: 'POST',
        headers: {
            'x-goog-api-key': geminiApiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...(systemInstruction ? {
                system_instruction: {
                    parts: [{ text: systemInstruction }],
                },
            } : {}),
            contents: [
                {
                    role: 'user',
                    parts: [{ text: prompt }],
                },
            ],
            generationConfig: {
                temperature: wantsJson ? 0.2 : 0.5,
                maxOutputTokens,
                ...(wantsJson ? { responseMimeType: 'application/json' } : {}),
            },
        }),
    });

    const data = await response.json();

    if (!response.ok) {
        const error = new Error(data.error?.message || 'Gemini provider request failed');
        error.statusCode = response.status;
        throw error;
    }

    return extractGeminiText(data);
}

function parseJsonOutput(text) {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    }
}

async function extractDocumentText(file) {
    if (file.mimetype === 'text/plain') {
        return file.buffer.toString('utf8');
    }

    if (file.mimetype === 'application/pdf') {
        const data = await pdfParse(file.buffer);
        return data.text || '';
    }

    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        return result.value || '';
    }

    throw new Error('Unsupported document type');
}

function buildDocumentFallback({ file, text }) {
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    const sentences = cleanedText
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
    const firstSentences = sentences.slice(0, 4);
    const actionSentences = sentences
        .filter((sentence) => /\b(should|must|required|need|submit|prepare|complete|review|approve|deadline|due)\b/i.test(sentence))
        .slice(0, 6);
    const tableLines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes('|') || /\S+\s{2,}\S+\s{2,}\S+/.test(line))
        .slice(0, 6);

    return {
        providerStatus: 'rules-preview',
        fileName: file.originalname,
        summary: firstSentences.join(' ') || 'The uploaded document was processed, but there was not enough readable text to create a detailed summary.',
        keyPoints: firstSentences.length
            ? firstSentences
            : ['Readable text was limited. Review the source document manually before using it for a proposal.'],
        tables: tableLines.map((line, index) => ({
            title: `Detected table-like line ${index + 1}`,
            headers: [],
            rows: [[line]],
        })),
        actionItems: actionSentences.length
            ? actionSentences.map((sentence) => ({
                task: sentence,
                owner: 'Applicant',
                priority: /must|required|deadline|due/i.test(sentence) ? 'High' : 'Medium',
            }))
            : [
                {
                    task: 'Review the uploaded document and confirm proposal requirements.',
                    owner: 'Applicant',
                    priority: 'Medium',
                },
            ],
        risks: [
            cleanedText.length < 500
                ? 'The extracted text is short, so some context may be missing.'
                : 'Validate extracted requirements against the original document.',
        ],
    };
}

function buildEligibilityFallback({ grant, user, notes }) {
    const eligibilityItems = grant.eligibility || [];
    const organizationProfile = user.organizationProfile || {};
    const profileText = [
        organizationProfile.name,
        organizationProfile.type,
        user.role,
        notes,
    ].filter(Boolean).join(' ').toLowerCase();
    const matchedItems = eligibilityItems.filter((item) => {
        const words = item.toLowerCase().split(/\W+/).filter((word) => word.length > 4);
        return words.some((word) => profileText.includes(word));
    });
    const score = Math.min(
        95,
        Math.max(45, Math.round((grant.match || 70) + matchedItems.length * 5 - Math.max(0, eligibilityItems.length - matchedItems.length) * 3))
    );

    return {
        providerStatus: 'rules-preview',
        summary: 'Gemini is not configured, so GrantPilot created a structured eligibility preview from your profile, notes, and the approved grant requirements.',
        eligibilityScore: score,
        readiness: score >= 82 ? 'Strong fit' : score >= 65 ? 'Needs review' : 'High risk',
        strengths: matchedItems.length
            ? matchedItems.slice(0, 4)
            : [
                `Your profile can be reviewed against ${grant.category || 'this'} funding criteria.`,
                `The grant is approved and available for public discovery.`,
            ],
        gaps: eligibilityItems
            .filter((item) => !matchedItems.includes(item))
            .slice(0, 4),
        requiredDocuments: [
            'Organization profile or registration proof',
            'Project budget',
            'Impact narrative',
            'Eligibility evidence mapped to funder requirements',
        ],
        nextSteps: [
            'Confirm each eligibility requirement with source evidence.',
            'Draft a short project description tied to the funder priority.',
            'Prepare a budget within the listed funding range.',
        ],
    };
}

function buildRecommendationFallback({ grants, interests, region, fundingRange, refinement }) {
    const normalizedInterests = (interests || []).map((item) => item.toLowerCase());
    const normalizedRegion = region.toLowerCase();
    const rankedGrants = grants
        .map((grant) => {
            const searchableText = [
                grant.title,
                grant.funder,
                grant.category,
                grant.region,
                grant.summary,
                ...(grant.eligibility || []),
            ].filter(Boolean).join(' ').toLowerCase();
            const interestBoost = normalizedInterests.filter((interest) => searchableText.includes(interest)).length * 8;
            const regionBoost = normalizedRegion && searchableText.includes(normalizedRegion) ? 6 : 0;
            const score = Math.min(98, Math.max(45, Math.round((grant.match || 70) + interestBoost + regionBoost)));

            return {
                grant,
                score,
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    return {
        providerStatus: 'rules-preview',
        summary: 'Gemini is not configured, so GrantPilot ranked approved grants using your filters, profile-ready signals, and grant metadata.',
        refinementTips: [
            refinement || 'Add your project focus, location, and funding target for sharper matches.',
            fundingRange ? `Review budget fit against ${fundingRange}.` : 'Add a preferred funding range.',
            'Run the eligibility agent on a saved grant before preparing a full proposal.',
        ],
        recommendations: rankedGrants.map(({ grant, score }) => ({
            slug: grant.slug,
            title: grant.title,
            score,
            reason: `${grant.title} aligns with ${grant.category || 'your selected'} funding priorities and has an approved listing in GrantPilot.`,
            evidence: [
                grant.summary || 'Approved grant summary is available.',
                grant.region ? `Region: ${grant.region}` : 'Region was not specified by the funder.',
                grant.deadline ? `Deadline: ${grant.deadline}` : 'Deadline is not specified.',
            ],
            nextStep: 'Open the grant details page, save it with your project description, and run the eligibility agent.',
            risk: (grant.eligibility || []).length
                ? 'Eligibility evidence must be checked before applying.'
                : 'Eligibility details are limited, so confirm requirements with the funder.',
        })),
    };
}

function buildChatFallback({ message, grants, previousMessages }) {
    const lowerMessage = message.toLowerCase();
    const topGrant = grants[0];

    if (lowerMessage.includes('eligibility')) {
        return [
            'Open an approved grant, add your application description, and click Run eligibility agent.',
            topGrant ? `A good place to start is ${topGrant.title}, because it is currently one of the stronger approved matches.` : 'Once grants are approved, I can help compare their requirements.',
            'The agent will save a report with strengths, gaps, required documents, and next steps.',
        ].join(' ');
    }

    if (lowerMessage.includes('save')) {
        return 'To save a grant, open its details page, add your application description, and click Save grant. Saved grants appear in the grant seeker dashboard.';
    }

    if (lowerMessage.includes('dashboard')) {
        return 'Use the Dashboard menu item after signing in. Admin users review and approve grants, funders track submitted grants, and grant seekers see approved and saved opportunities.';
    }

    return [
        'Gemini is not configured yet, so I am answering from the local GrantPilot data.',
        topGrant ? `The top approved grant right now is ${topGrant.title} from ${topGrant.funder}.` : 'No approved grants are available yet.',
        previousMessages.length ? 'I also kept your recent conversation context in the thread.' : 'Ask about eligibility, saved grants, dashboards, or proposal next steps.',
    ].join(' ');
}

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db(dbName);
        const usersCollection = db.collection('users');
        const sessionsCollection = db.collection('sessions');
        const grantsCollection = db.collection('grants');
        const conversationsCollection = db.collection('conversations');
        const interactionsCollection = db.collection('interactions');
        const savedGrantsCollection = db.collection('savedGrants');
        const eligibilityReportsCollection = db.collection('eligibilityReports');
        const documentAnalysesCollection = db.collection('documentAnalyses');

        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await sessionsCollection.createIndex({ token: 1 }, { unique: true });
        await grantsCollection.createIndex({ slug: 1 }, { unique: true });
        await conversationsCollection.createIndex({ userId: 1, updatedAt: -1 });
        await interactionsCollection.createIndex({ userId: 1, createdAt: -1 });
        await savedGrantsCollection.createIndex({ userId: 1, grantSlug: 1 }, { unique: true });
        await savedGrantsCollection.createIndex({ userId: 1, updatedAt: -1 });
        await eligibilityReportsCollection.createIndex({ userId: 1, grantSlug: 1, createdAt: -1 });
        await documentAnalysesCollection.createIndex({ userId: 1, createdAt: -1 });

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
                    funderApprovalStatus: getFunderApprovalStatus(selectedRole, 'pending'),
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
                    user: serializeUser({ ...user, _id: result.insertedId }),
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
                    user: serializeUser(user),
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

        app.get('/api/my/saved-grants', verifyToken, async (req, res) => {
            const savedItems = await savedGrantsCollection
                .find({ userId: req.user._id })
                .sort({ updatedAt: -1 })
                .toArray();
            const grantSlugs = savedItems.map((item) => item.grantSlug);
            const grants = await grantsCollection
                .find({ slug: { $in: grantSlugs }, approvalStatus: 'approved' })
                .toArray();
            const grantsBySlug = new Map(grants.map((grant) => [grant.slug, grant]));

            res.send(savedItems.map((savedItem) => ({
                ...savedItem,
                grant: grantsBySlug.get(savedItem.grantSlug) || null,
            })).filter((savedItem) => savedItem.grant));
        });

        app.post('/api/grants/:slug/save', verifyToken, async (req, res) => {
            const grant = await grantsCollection.findOne({
                slug: req.params.slug,
                approvalStatus: 'approved',
            });

            if (!grant) {
                return res.status(404).send({ message: 'Grant not found or not approved' });
            }

            const notes = req.body?.notes?.trim() || '';
            const savedGrant = {
                userId: req.user._id,
                grantId: grant._id,
                grantSlug: grant.slug,
                notes,
                updatedAt: new Date(),
            };

            await savedGrantsCollection.updateOne(
                { userId: req.user._id, grantSlug: grant.slug },
                {
                    $set: savedGrant,
                    $setOnInsert: { createdAt: new Date() },
                },
                { upsert: true }
            );

            const saved = await savedGrantsCollection.findOne({
                userId: req.user._id,
                grantSlug: grant.slug,
            });

            res.send({ message: 'Grant saved', savedGrant: saved });
        });

        app.post('/api/grants/:slug/eligibility', verifyToken, async (req, res) => {
            try {
                const notes = req.body?.notes?.trim() || '';
                const grant = await grantsCollection.findOne({
                    slug: req.params.slug,
                    approvalStatus: 'approved',
                });

                if (!grant) {
                    return res.status(404).send({ message: 'Grant not found or not approved' });
                }

                const recentInteractions = await interactionsCollection
                    .find({ userId: req.user._id })
                    .sort({ createdAt: -1 })
                    .limit(10)
                    .toArray();
                const promptPayload = {
                    user: {
                        name: req.user.name,
                        role: req.user.role,
                        organizationProfile: req.user.organizationProfile || {},
                        preferences: req.user.preferences || {},
                    },
                    applicantNotes: notes,
                    recentInteractions,
                    grant: {
                        slug: grant.slug,
                        title: grant.title,
                        funder: grant.funder,
                        category: grant.category,
                        amount: grant.amount,
                        minAmount: grant.minAmount,
                        maxAmount: grant.maxAmount,
                        deadline: grant.deadline,
                        region: grant.region,
                        eligibility: grant.eligibility,
                        summary: grant.summary,
                    },
                };

                let report;

                if (process.env.GEMINI_API_KEY?.trim()) {
                    const aiText = await callGemini({
                        input: [
                            {
                                role: 'system',
                                content: 'You are GrantPilot Eligibility Agent. Decide whether the signed-in organization is ready to pursue the approved grant. Use only supplied user profile, applicant notes, interaction memory, and grant data. Return practical evidence requirements and next actions.',
                            },
                            {
                                role: 'user',
                                content: `Analyze eligibility and return JSON for this context:\n${JSON.stringify(promptPayload)}`,
                            },
                        ],
                        text: {
                            format: {
                                type: 'json_schema',
                                name: 'eligibility_report',
                                strict: true,
                                schema: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['providerStatus', 'summary', 'eligibilityScore', 'readiness', 'strengths', 'gaps', 'requiredDocuments', 'nextSteps'],
                                    properties: {
                                        providerStatus: { type: 'string' },
                                        summary: { type: 'string' },
                                        eligibilityScore: { type: 'number' },
                                        readiness: { type: 'string' },
                                        strengths: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                        gaps: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                        requiredDocuments: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                        nextSteps: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                    });

                    report = parseJsonOutput(aiText) || buildEligibilityFallback({ grant, user: req.user, notes });
                } else {
                    report = buildEligibilityFallback({ grant, user: req.user, notes });
                }

                const eligibilityRecord = {
                    userId: req.user._id,
                    grantId: grant._id,
                    grantSlug: grant.slug,
                    notes,
                    report,
                    createdAt: new Date(),
                };

                const result = await eligibilityReportsCollection.insertOne(eligibilityRecord);

                await interactionsCollection.insertOne({
                    userId: req.user._id,
                    eventType: 'eligibility_agent',
                    metadata: { grantSlug: grant.slug, notes },
                    output: report,
                    createdAt: new Date(),
                });

                res.send({
                    reportId: result.insertedId,
                    grantSlug: grant.slug,
                    report,
                });
            } catch (error) {
                res.status(error.statusCode || 500).send({ message: error.message || 'Failed to run eligibility agent' });
            }
        });

        app.post('/api/ai/recommend', verifyToken, async (req, res) => {
            try {
                const { interests = [], region = '', fundingRange = '', refinement = '' } = req.body;
                const grants = await grantsCollection
                    .find({ approvalStatus: 'approved' })
                    .sort({ match: -1 })
                    .limit(30)
                    .toArray();
                const recentInteractions = await interactionsCollection
                    .find({ userId: req.user._id })
                    .sort({ createdAt: -1 })
                    .limit(12)
                    .toArray();

                const promptPayload = {
                    user: {
                        role: req.user.role,
                        organizationProfile: req.user.organizationProfile || {},
                        preferences: req.user.preferences || {},
                    },
                    filters: { interests, region, fundingRange, refinement },
                    recentInteractions,
                    approvedGrants: grants.map((grant) => ({
                        slug: grant.slug,
                        title: grant.title,
                        funder: grant.funder,
                        category: grant.category,
                        amount: grant.amount,
                        maxAmount: grant.maxAmount,
                        deadline: grant.deadline,
                        region: grant.region,
                        match: grant.match,
                        eligibility: grant.eligibility,
                        summary: grant.summary,
                    })),
                };

                let recommendation;

                if (process.env.GEMINI_API_KEY?.trim()) {
                    const aiText = await callGemini({
                        input: [
                            {
                                role: 'system',
                                content: 'You are GrantPilot AI Recommendation Agent. Rank approved grants using user profile, stated filters, and interaction history. Give evidence-based, practical recommendations only from the supplied grants.',
                            },
                            {
                                role: 'user',
                                content: `Return structured JSON recommendations for this context:\n${JSON.stringify(promptPayload)}`,
                            },
                        ],
                        text: {
                            format: {
                                type: 'json_schema',
                                name: 'grant_recommendations',
                                strict: true,
                                schema: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['summary', 'recommendations', 'refinementTips'],
                                    properties: {
                                        summary: { type: 'string' },
                                        refinementTips: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                        recommendations: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                additionalProperties: false,
                                                required: ['slug', 'title', 'score', 'reason', 'evidence', 'nextStep', 'risk'],
                                                properties: {
                                                    slug: { type: 'string' },
                                                    title: { type: 'string' },
                                                    score: { type: 'number' },
                                                    reason: { type: 'string' },
                                                    evidence: {
                                                        type: 'array',
                                                        items: { type: 'string' },
                                                    },
                                                    nextStep: { type: 'string' },
                                                    risk: { type: 'string' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    });

                    recommendation = parseJsonOutput(aiText) || buildRecommendationFallback({
                        grants,
                        interests,
                        region,
                        fundingRange,
                        refinement,
                    });
                } else {
                    recommendation = buildRecommendationFallback({
                        grants,
                        interests,
                        region,
                        fundingRange,
                        refinement,
                    });
                }

                await interactionsCollection.insertOne({
                    userId: req.user._id,
                    eventType: 'ai_recommendation',
                    metadata: { interests, region, fundingRange, refinement },
                    output: recommendation,
                    createdAt: new Date(),
                });

                res.send(recommendation);
            } catch (error) {
                res.status(error.statusCode || 500).send({ message: error.message || 'Failed to generate recommendations' });
            }
        });

        app.get('/api/ai/conversations/:id', verifyToken, async (req, res) => {
            if (!ObjectId.isValid(req.params.id)) {
                return res.status(400).send({ message: 'Invalid conversation id' });
            }

            const conversation = await conversationsCollection.findOne({
                _id: new ObjectId(req.params.id),
                userId: req.user._id,
            });

            if (!conversation) {
                return res.status(404).send({ message: 'Conversation not found' });
            }

            res.send(conversation);
        });

        app.post('/api/ai/chat', verifyToken, async (req, res) => {
            try {
                const { message, conversationId } = req.body;

                if (!message?.trim()) {
                    return res.status(400).send({ message: 'Message is required' });
                }

                const grants = await grantsCollection
                    .find({ approvalStatus: 'approved' })
                    .sort({ match: -1 })
                    .limit(12)
                    .toArray();
                const conversationQuery = conversationId && ObjectId.isValid(conversationId)
                    ? { _id: new ObjectId(conversationId), userId: req.user._id }
                    : null;
                const existingConversation = conversationQuery
                    ? await conversationsCollection.findOne(conversationQuery)
                    : null;
                const previousMessages = existingConversation?.messages || [];
                const userMessage = {
                    role: 'user',
                    content: message.trim(),
                    createdAt: new Date(),
                };

                const context = {
                    user: {
                        role: req.user.role,
                        organizationProfile: req.user.organizationProfile || {},
                    },
                    approvedGrants: grants.map((grant) => ({
                        slug: grant.slug,
                        title: grant.title,
                        funder: grant.funder,
                        category: grant.category,
                        amount: grant.amount,
                        deadline: grant.deadline,
                        eligibility: grant.eligibility,
                        summary: grant.summary,
                    })),
                    previousMessages: previousMessages.slice(-8).map(({ role, content }) => ({ role, content })),
                };

                const aiContent = process.env.GEMINI_API_KEY?.trim()
                    ? await callGemini({
                        input: [
                            {
                                role: 'system',
                                content: 'You are GrantPilot AI Chat Assistant. Help users navigate this grant app, understand approved grants, reason about eligibility, and suggest next actions. Use prior conversation context. Do not invent unapproved grants.',
                            },
                            {
                                role: 'user',
                                content: `Context:\n${JSON.stringify(context)}\n\nUser question:\n${message.trim()}`,
                            },
                        ],
                    })
                    : buildChatFallback({
                        message: message.trim(),
                        grants,
                        previousMessages,
                    });

                const assistantMessage = {
                    role: 'assistant',
                    content: aiContent,
                    createdAt: new Date(),
                };
                const messages = [...previousMessages, userMessage, assistantMessage];

                const savedConversation = existingConversation
                    ? await conversationsCollection.findOneAndUpdate(
                        { _id: existingConversation._id },
                        {
                            $set: {
                                messages,
                                updatedAt: new Date(),
                            },
                        },
                        { returnDocument: 'after' }
                    )
                    : await conversationsCollection.insertOne({
                        userId: req.user._id,
                        title: message.trim().slice(0, 60),
                        messages,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    });

                const savedId = existingConversation?._id || savedConversation.insertedId;

                res.send({
                    conversationId: savedId,
                    message: assistantMessage,
                    suggestedPrompts: [
                        'Which grants have the clearest eligibility fit?',
                        'What evidence should I prepare first?',
                        'Help me compare the top two opportunities.',
                    ],
                });
            } catch (error) {
                res.status(error.statusCode || 500).send({ message: error.message || 'Failed to send chat message' });
            }
        });

        app.post('/api/ai/documents/analyze', verifyToken, upload.single('document'), async (req, res) => {
            try {
                const file = req.file;

                if (!file) {
                    return res.status(400).send({ message: 'Document file is required' });
                }

                const extractedText = (await extractDocumentText(file)).trim();

                if (!extractedText) {
                    return res.status(400).send({ message: 'Could not extract readable text from this document' });
                }

                const documentText = extractedText.slice(0, 22000);
                const promptPayload = {
                    file: {
                        name: file.originalname,
                        type: file.mimetype,
                        size: file.size,
                    },
                    user: {
                        role: req.user.role,
                        organizationProfile: req.user.organizationProfile || {},
                    },
                    documentText,
                };
                let analysis;

                if (process.env.GEMINI_API_KEY?.trim()) {
                    const aiText = await callGemini({
                        input: [
                            {
                                role: 'system',
                                content: 'You are GrantPilot Document Intelligence Agent. Analyze uploaded grant/proposal documents. Produce concise summaries, extract key points, detect table-like information, identify action items, and call out proposal risks. Use only the supplied document text.',
                            },
                            {
                                role: 'user',
                                content: `Analyze this uploaded document and return JSON:\n${JSON.stringify(promptPayload)}`,
                            },
                        ],
                        text: {
                            format: {
                                type: 'json_schema',
                                name: 'document_intelligence',
                                strict: true,
                                schema: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['providerStatus', 'fileName', 'summary', 'keyPoints', 'tables', 'actionItems', 'risks'],
                                    properties: {
                                        providerStatus: { type: 'string' },
                                        fileName: { type: 'string' },
                                        summary: { type: 'string' },
                                        keyPoints: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                        tables: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                additionalProperties: false,
                                                required: ['title', 'headers', 'rows'],
                                                properties: {
                                                    title: { type: 'string' },
                                                    headers: {
                                                        type: 'array',
                                                        items: { type: 'string' },
                                                    },
                                                    rows: {
                                                        type: 'array',
                                                        items: {
                                                            type: 'array',
                                                            items: { type: 'string' },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                        actionItems: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                additionalProperties: false,
                                                required: ['task', 'owner', 'priority'],
                                                properties: {
                                                    task: { type: 'string' },
                                                    owner: { type: 'string' },
                                                    priority: { type: 'string' },
                                                },
                                            },
                                        },
                                        risks: {
                                            type: 'array',
                                            items: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                        maxOutputTokens: 1800,
                    });

                    analysis = parseJsonOutput(aiText) || buildDocumentFallback({ file, text: extractedText });
                } else {
                    analysis = buildDocumentFallback({ file, text: extractedText });
                }

                const documentAnalysis = {
                    userId: req.user._id,
                    fileName: file.originalname,
                    fileType: file.mimetype,
                    fileSize: file.size,
                    textPreview: documentText.slice(0, 1200),
                    analysis,
                    createdAt: new Date(),
                };
                const result = await documentAnalysesCollection.insertOne(documentAnalysis);

                await interactionsCollection.insertOne({
                    userId: req.user._id,
                    eventType: 'document_intelligence',
                    metadata: {
                        fileName: file.originalname,
                        fileType: file.mimetype,
                        fileSize: file.size,
                    },
                    output: analysis,
                    createdAt: new Date(),
                });

                res.send({
                    analysisId: result.insertedId,
                    analysis,
                });
            } catch (error) {
                res.status(error.statusCode || 500).send({ message: error.message || 'Failed to analyze document' });
            }
        });

        app.get('/api/admin/grants', verifyToken, verifyAdmin, async (req, res) => {
            const grants = await grantsCollection.find().sort({ updatedAt: -1 }).toArray();
            res.send(grants);
        });

        app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
            const [totalGrants, approvedGrants, pendingGrants, rejectedGrants, pendingFunders, approvedFunders, rejectedFunders, usersByRole] = await Promise.all([
                grantsCollection.countDocuments(),
                grantsCollection.countDocuments({ approvalStatus: 'approved' }),
                grantsCollection.countDocuments({
                    $or: [{ approvalStatus: 'pending' }, { approvalStatus: { $exists: false } }],
                }),
                grantsCollection.countDocuments({ approvalStatus: 'rejected' }),
                usersCollection.countDocuments({
                    role: 'funder',
                    $or: [{ funderApprovalStatus: 'pending' }, { funderApprovalStatus: { $exists: false } }],
                }),
                usersCollection.countDocuments({ role: 'funder', funderApprovalStatus: 'approved' }),
                usersCollection.countDocuments({ role: 'funder', funderApprovalStatus: 'rejected' }),
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
                funders: {
                    pending: pendingFunders,
                    approved: approvedFunders,
                    rejected: rejectedFunders,
                },
                usersByRole,
            });
        });

        app.get('/api/admin/funders', verifyToken, verifyAdmin, async (req, res) => {
            const funders = await usersCollection
                .find({ role: 'funder' }, { projection: { passwordHash: 0 } })
                .sort({ updatedAt: -1, createdAt: -1 })
                .toArray();

            res.send(funders.map((funder) => ({
                ...funder,
                funderApprovalStatus: getFunderApprovalStatus(funder.role, funder.funderApprovalStatus),
            })));
        });

        app.get('/api/my/grants', verifyToken, async (req, res) => {
            if (!['funder', 'admin'].includes(req.user?.role)) {
                return res.status(403).send({ message: 'Funder access required' });
            }

            if (req.user?.role === 'funder' && getFunderApprovalStatus(req.user.role, req.user.funderApprovalStatus) !== 'approved') {
                return res.status(403).send({ message: 'Your funder registration is waiting for admin approval.' });
            }

            const grants = await grantsCollection.find({ createdBy: req.user._id }).sort({ updatedAt: -1 }).toArray();
            res.send(grants);
        });

        app.patch('/api/admin/funders/:id/approval', verifyToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const { approvalStatus } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'Invalid funder id' });
            }

            if (!funderApprovalStatuses.includes(approvalStatus)) {
                return res.status(400).send({ message: 'Invalid funder approval status' });
            }

            const update = {
                $set: {
                    funderApprovalStatus: approvalStatus,
                    funderApprovedBy: approvalStatus === 'approved' ? req.user._id : null,
                    funderApprovedAt: approvalStatus === 'approved' ? new Date() : null,
                    updatedAt: new Date(),
                },
            };

            const result = await usersCollection.updateOne({ _id: new ObjectId(id), role: 'funder' }, update);

            if (result.matchedCount === 0) {
                return res.status(404).send({ message: 'Funder account not found' });
            }

            const funder = await usersCollection.findOne(
                { _id: new ObjectId(id) },
                { projection: { passwordHash: 0 } },
            );

            res.send({
                message: `Funder marked as ${approvalStatus}`,
                funder: {
                    ...funder,
                    funderApprovalStatus: getFunderApprovalStatus(funder.role, funder.funderApprovalStatus),
                },
            });
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

        app.delete('/api/admin/grants/:id', verifyToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'Invalid grant id' });
            }

            const grant = await grantsCollection.findOne({ _id: new ObjectId(id) });

            if (!grant) {
                return res.status(404).send({ message: 'Grant not found' });
            }

            if ((grant.approvalStatus || 'pending') !== 'rejected') {
                return res.status(400).send({ message: 'Only rejected grants can be deleted' });
            }

            await Promise.all([
                grantsCollection.deleteOne({ _id: grant._id }),
                savedGrantsCollection.deleteMany({ grantSlug: grant.slug }),
                eligibilityReportsCollection.deleteMany({ grantSlug: grant.slug }),
            ]);

            res.send({ message: 'Rejected grant deleted', deletedId: id });
        });

        app.use((error, req, res, next) => {
            if (error instanceof multer.MulterError || error.message?.includes('PDF, DOCX, and TXT')) {
                return res.status(400).send({ message: error.message });
            }

            next(error);
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
