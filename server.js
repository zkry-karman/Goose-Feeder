const express = require('express');
const session = require('express-session');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const multer = require('multer');
const filter = require('leo-profanity');
const path = require('path');

const app = express();

// --- MULTER IMAGE UPLOAD STORAGE SETUP ---
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, 'catpost-' + Date.now() + path.extname(file.originalname));
    }
});

const imageFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const isExtValid = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const isMimeValid = allowedTypes.test(file.mimetype);

    if (isExtValid && isMimeValid) {
        return cb(null, true);
    }
    cb(new Error('Security Block: Only image files are permitted!'), false);
};

const upload = multer({ 
    storage: storage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// --- MIDDLEWARE LAYERS ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads')); 
app.use(express.static(__dirname));

app.use(session({
    secret: 'super_secret_kitty_key_9999',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        httpOnly: true, 
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// --- GLOBAL SECURITY MIDDLEWARE ---
function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ status: "Error", message: "Access Denied: Please sign in first!" });
    }
    next();
}

let db;
(async () => {
    db = await open({
        filename: './community_wall.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT,
            password TEXT,
            token_balance INTEGER DEFAULT 20 -- ✅ FIXED: Matches the 20 tokens promise!
        );

        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            content TEXT,
            image_url TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            user_id INTEGER,
            username TEXT,
            content TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(post_id) REFERENCES posts(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS likes (
            post_id INTEGER,
            user_id INTEGER,
            PRIMARY KEY (post_id, user_id),
            FOREIGN KEY(post_id) REFERENCES posts(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    `);
    console.log("🔒 Secure SQLite Core Engine Initialized.");
})();

// --- API WALL CONTROLLER ROUTES ---

app.get('/api/posts', async (req, res) => {
    try {
        const posts = await db.all(`
            SELECT p.*, 
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS total_likes,
            EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) AS user_has_liked
            FROM posts p ORDER BY p.timestamp DESC
        `, [req.session.userId || 0]);

        // ✅ FIXED: Safer async processing for nested comments loop
        await Promise.all(posts.map(async (post) => {
            post.comments = await db.all(`
                SELECT id, username, content, timestamp FROM comments 
                WHERE post_id = ? ORDER BY timestamp ASC
            `, [post.id]);
        }));

        res.json({ status: "Success", posts });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Database read failure." });
    }
});

app.post('/api/posts', requireAuth, upload.single('image'), async (req, res) => {
    try {
        let content = req.body.content || "";
        
        if (filter.check(content)) {
            return res.status(400).json({ 
                status: "Error", 
                message: "Post rejected: Please refrain from using inappropriate language!" 
            });
        }

        const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

        await db.run(
            `INSERT INTO posts (user_id, username, content, image_url) VALUES (?, ?, ?, ?)`,
            [req.session.userId, req.session.username, content, imageUrl]
        );

        res.json({ status: "Success", message: "Post shared successfully!" });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Failed to broadcast post." });
    }
});

app.post('/api/posts/:id/like', requireAuth, async (req, res) => {
    const postId = req.params.id;
    const userId = req.session.userId;

    try {
        const alreadyLiked = await db.get(`SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?`, [postId, userId]);

        if (alreadyLiked) {
            await db.run(`DELETE FROM likes WHERE post_id = ? AND user_id = ?`, [postId, userId]);
            res.json({ status: "Success", message: "Unliked", liked: false });
        } else {
            await db.run(`INSERT INTO likes (post_id, user_id) VALUES (?, ?)`, [postId, userId]);
            res.json({ status: "Success", message: "Liked", liked: true });
        }
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Like action failed state handling." });
    }
});

app.post('/api/posts/:id/comments', requireAuth, async (req, res) => {
    try {
        const postId = req.params.id;
        let content = req.body.content || "";

        if (filter.check(content)) {
            return res.status(400).json({ 
                status: "Error", 
                message: "Comment rejected: Please keep comments safe and respectful!" 
            });
        }

        await db.run(
            `INSERT INTO comments (post_id, user_id, username, content) VALUES (?, ?, ?, ?)`,
            [postId, req.session.userId, req.session.username, content]
        );

        res.json({ status: "Success", message: "Comment added!" });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Comment transmission failure." });
    }
});

// --- SHARED DISPENSER LINE STATE (lives in memory, same for every visitor) ---
let dispenserQueue = [];      // [{ ticket, userId, username }] — people waiting
let nowServing = null;        // { ticket, userId, username } — whose treat is dropping
let recentDrops = [];         // [{ ticket, username, at }] — newest first
let isProcessingQueue = false;
let ticketCounter = 1;

const MOTOR_DELAY = 3000;     // physical dispenser cycle
const RECENT_LIMIT = 12;      // how many past drops we keep for the "thank you" feed

// One live ticket per person: you can't join the line twice.
function userInLine(userId) {
    if (nowServing && nowServing.userId === userId) return true;
    return dispenserQueue.some(entry => entry.userId === userId);
}

app.get('/api/me', async (req, res) => {
    if (req.session && req.session.userId) {
        try {
            const user = await db.get(`SELECT token_balance FROM users WHERE id = ?`, [req.session.userId]);
            return res.json({ 
                loggedIn: true, 
                username: req.session.username,
                tokens: user ? user.token_balance : 0 
            });
        } catch (err) {
            return res.json({ loggedIn: false });
        }
    }
    res.json({ loggedIn: false });
});

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ status: "Error", message: "All fields are required!" });
    }
    try {
        const result = await db.run(
            `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`, 
            [username, email, password]
        );

        // Log them straight in — no second trip through the sign-in form
        req.session.userId = result.lastID;
        req.session.username = username;

        res.json({ status: "Success", loggedIn: true, message: "You're in! Enjoy your 20 free 🐟 tokens." });
    } catch (err) {
        res.status(400).json({ status: "Error", message: "Username is already taken." });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password]);

        if (user) {
            req.session.userId = user.id;
            req.session.username = user.username;
            return res.json({ status: "Success", message: "Welcome back!" });
        }
        
        res.status(401).json({ status: "Error", message: "Invalid username or password." });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Internal server authentication error." });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ message: "Could not log out." });
        res.clearCookie('connect.sid');
        res.json({ status: "Success", message: "Logged out successfully!" });
    });
});

// --- LIVE LINE STATUS (polled by every browser on the page) ---
app.get('/api/queue', (req, res) => {
    const userId = req.session && req.session.userId;
    res.json({
        serving: nowServing ? { ticket: nowServing.ticket, username: nowServing.username } : null,
        queue: dispenserQueue.map((entry, i) => ({
            ticket: entry.ticket,
            username: entry.username,
            position: i + 1
        })),
        recent: recentDrops,
        inLine: userId ? userInLine(userId) : false
    });
});

// --- JOIN THE TREAT LINE ---
// This no longer holds the HTTP response open. It takes the token, puts you in
// line and answers immediately; the browser watches /api/queue for your turn.
app.get('/dispense', requireAuth, async (req, res) => {
    const userId = req.session.userId;

    // GUARDRAIL: one ticket per person. No joining the line twice.
    if (userInLine(userId)) {
        return res.json({
            status: "Error",
            code: "already_queued",
            message: "You're already in line! Wait for your treat to drop."
        });
    }

    try {
        const user = await db.get(`SELECT token_balance FROM users WHERE id = ?`, [userId]);

        if (!user) {
            return res.status(404).json({ status: "Error", code: "no_user", message: "User account profile not found." });
        }

        if (user.token_balance <= 0) {
            return res.json({ status: "Error", code: "no_tokens", message: "Out of tokens! Recharge to feed Goose." });
        }

        // Charge the token up front so the same one can't be spent twice while waiting
        await db.run(`UPDATE users SET token_balance = token_balance - 1 WHERE id = ?`, [userId]);

        const entry = { ticket: ticketCounter++, userId, username: req.session.username };
        dispenserQueue.push(entry);

        res.json({
            status: "Success",
            code: "queued",
            ticket: entry.ticket,
            position: dispenserQueue.length,
            remainingTokens: user.token_balance - 1
        });

        processDispenserQueue();

    } catch (err) {
        res.status(500).json({ status: "Error", code: "server", message: "Could not reach the dispenser." });
    }
});

// --- QUEUE PROCESSING ENGINE ---
async function processDispenserQueue() {
    if (isProcessingQueue) return;
    if (dispenserQueue.length === 0) return;

    isProcessingQueue = true;
    nowServing = dispenserQueue.shift();

    console.log(`⚡ Dispensing for ${nowServing.username}. (${dispenserQueue.length} still waiting)`);

    try {
        // ===== HARDWARE HOOK =====
        // When the real dispenser arrives, replace this timer with the motor call,
        // e.g. await runDispenserMotor();  — everything else keeps working.
        await new Promise(resolve => setTimeout(resolve, MOTOR_DELAY));

        recentDrops.unshift({
            ticket: nowServing.ticket,
            username: nowServing.username,
            at: Date.now()
        });
        recentDrops = recentDrops.slice(0, RECENT_LIMIT);

    } catch (err) {
        console.error("Dispenser motor failed:", err);
        // Motor failed, so give the token back rather than eating it
        try {
            await db.run(`UPDATE users SET token_balance = token_balance + 1 WHERE id = ?`, [nowServing.userId]);
        } catch (refundErr) {
            console.error("Refund failed:", refundErr);
        }
    }

    nowServing = null;
    isProcessingQueue = false;
    processDispenserQueue();
}
app.listen(3000, () => console.log('🚀 secure server mapping activated at http://localhost:3000'));