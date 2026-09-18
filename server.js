const express = require('express');
const session = require('express-session');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const multer = require('multer');
const filter = require('leo-profanity');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();

const SALT_ROUNDS = 10;

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
    secret: process.env.SESSION_SECRET || 'super_secret_kitty_key_9999',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 30   // 30 days; the browser keeps you signed in
    }
}));

// --- GLOBAL SECURITY MIDDLEWARE ---
function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ status: "Error", message: "Access Denied: Please sign in first!" });
    }
    next();
}

async function requireAdmin(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ status: "Error", message: "Sign in first." });
    }
    const me = await db.get(`SELECT is_admin FROM users WHERE id = ?`, [req.session.userId]);
    if (!me || !me.is_admin) {
        return res.status(403).json({ status: "Error", message: "Moderators only." });
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
            token_balance INTEGER DEFAULT 20,
            avatar TEXT DEFAULT 'orange-tabby-gold',
            cat_name TEXT,
            breed TEXT,
            birthday TEXT,
            country TEXT,
            fav_food TEXT,
            is_admin INTEGER DEFAULT 0,
            created_at TEXT
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

    // --- SCHEMA MIGRATION: add any profile columns an older DB is missing ---
    const existing = await db.all(`PRAGMA table_info(users)`);
    const have = new Set(existing.map(c => c.name));
    const wanted = {
        avatar:        `TEXT DEFAULT 'orange-tabby-gold'`,
        cat_name:      `TEXT`,
        breed:         `TEXT`,
        birthday:      `TEXT`,
        country:       `TEXT`,
        fav_food:      `TEXT`,
        is_admin:      `INTEGER DEFAULT 0`,
        created_at:    `TEXT`
    };
    for (const [col, def] of Object.entries(wanted)) {
        if (!have.has(col)) {
            await db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
            console.log(`🛠  Added missing users.${col} column.`);
        }
    }

    console.log("🔒 Secure SQLite Core Engine Initialized.");
})();

// Public profile shape — never includes the password hash or the email
const PUBLIC_PROFILE = `username, avatar, cat_name, breed, birthday, country, fav_food, is_admin`;

// --- API WALL CONTROLLER ROUTES ---

app.get('/api/posts', async (req, res) => {
    try {
        const posts = await db.all(`
            SELECT p.*,
            u.avatar AS avatar,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS total_likes,
            EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) AS user_has_liked
            FROM posts p LEFT JOIN users u ON u.id = p.user_id
            ORDER BY p.timestamp DESC
        `, [req.session.userId || 0]);

        await Promise.all(posts.map(async (post) => {
            post.comments = await db.all(`
                SELECT c.id, c.user_id, c.username, c.content, c.timestamp, u.avatar AS avatar
                FROM comments c LEFT JOIN users u ON u.id = c.user_id
                WHERE c.post_id = ? ORDER BY c.timestamp ASC
            `, [post.id]);
        }));

        res.json({ status: "Success", posts });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Database read failure." });
    }
});

// Every profile on the wall, for the hover cards
app.get('/api/profiles', async (req, res) => {
    try {
        const rows = await db.all(`SELECT ${PUBLIC_PROFILE} FROM users`);
        const map = {};
        rows.forEach(r => { map[r.username] = r; });
        res.json({ status: "Success", profiles: map });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Could not load profiles." });
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

// --- DELETE A POST (author or moderator) ---
app.delete('/api/posts/:id', requireAuth, async (req, res) => {
    try {
        const post = await db.get(`SELECT * FROM posts WHERE id = ?`, [req.params.id]);
        if (!post) {
            return res.status(404).json({ status: "Error", code: "not_found", message: "That post is already gone." });
        }

        const me = await db.get(`SELECT is_admin FROM users WHERE id = ?`, [req.session.userId]);
        const isOwner = post.user_id === req.session.userId;
        if (!isOwner && !(me && me.is_admin)) {
            return res.status(403).json({ status: "Error", code: "not_yours", message: "You can only delete your own posts." });
        }

        await db.run(`DELETE FROM comments WHERE post_id = ?`, [post.id]);
        await db.run(`DELETE FROM likes WHERE post_id = ?`, [post.id]);
        await db.run(`DELETE FROM posts WHERE id = ?`, [post.id]);

        // Best effort: drop the uploaded image too so /uploads doesn't grow forever
        if (post.image_url) {
            fs.unlink(path.join(__dirname, post.image_url), () => {});
        }

        res.json({ status: "Success", message: "Post deleted." });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Could not delete that post." });
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

// --- DELETE A COMMENT (author or moderator) ---
app.delete('/api/comments/:id', requireAuth, async (req, res) => {
    try {
        const comment = await db.get(`SELECT * FROM comments WHERE id = ?`, [req.params.id]);
        if (!comment) {
            return res.status(404).json({ status: "Error", code: "not_found", message: "That comment is already gone." });
        }

        const me = await db.get(`SELECT is_admin FROM users WHERE id = ?`, [req.session.userId]);
        const isOwner = comment.user_id === req.session.userId;
        if (!isOwner && !(me && me.is_admin)) {
            return res.status(403).json({ status: "Error", code: "not_yours", message: "You can only delete your own comments." });
        }

        await db.run(`DELETE FROM comments WHERE id = ?`, [comment.id]);
        res.json({ status: "Success", message: "Comment deleted." });
    } catch (err) {
        res.status(500).json({ status: "Error", message: "Could not delete that comment." });
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
            const user = await db.get(
                `SELECT token_balance, avatar, is_admin FROM users WHERE id = ?`,
                [req.session.userId]
            );
            if (!user) return res.json({ loggedIn: false });
            return res.json({
                loggedIn: true,
                username: req.session.username,
                tokens: user.token_balance,
                avatar: user.avatar || 'orange-tabby-gold',
                isAdmin: !!user.is_admin
            });
        } catch (err) {
            return res.json({ loggedIn: false });
        }
    }
    res.json({ loggedIn: false });
});

app.post('/register', async (req, res) => {
    const {
        username, email, password,
        avatar, cat_name, breed, birthday, country, fav_food
    } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ status: "Error", message: "Username, email and password are required!" });
    }
    if (String(password).length < 6) {
        return res.status(400).json({ status: "Error", message: "Password must be at least 6 characters." });
    }
    if (filter.check(username)) {
        return res.status(400).json({ status: "Error", message: "Please pick a friendlier username." });
    }

    try {
        const hashed = await bcrypt.hash(String(password), SALT_ROUNDS);

        const result = await db.run(
            `INSERT INTO users
             (username, email, password, avatar, cat_name, breed, birthday, country, fav_food, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                username, email, hashed,
                avatar || 'orange-tabby-gold',
                cat_name || null, breed || null, birthday || null,
                country || null, fav_food || null,
                new Date().toISOString()
            ]
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
        const user = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
        let ok = false;

        if (user) {
            if (String(user.password).startsWith('$2')) {
                // Normal path: stored as a bcrypt hash
                ok = await bcrypt.compare(String(password), user.password);
            } else {
                // Legacy account from before hashing — verify, then upgrade in place
                ok = user.password === password;
                if (ok) {
                    const upgraded = await bcrypt.hash(String(password), SALT_ROUNDS);
                    await db.run(`UPDATE users SET password = ? WHERE id = ?`, [upgraded, user.id]);
                    console.log(`🔑 Upgraded ${user.username}'s password to a hash.`);
                }
            }
        }

        if (ok) {
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
app.get('/dispense', requireAuth, async (req, res) => {
    const userId = req.session.userId;

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

// --- MODERATOR ENDPOINT (used by the site when logged in as an admin) ---
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const users = await db.all(`
        SELECT id, username, email, token_balance, avatar, cat_name, breed,
               birthday, country, fav_food, is_admin, created_at,
               (SELECT COUNT(*) FROM posts WHERE user_id = users.id) AS post_count,
               (SELECT COUNT(*) FROM comments WHERE user_id = users.id) AS comment_count
        FROM users ORDER BY id
    `);
    res.json({ status: "Success", users });
});

app.listen(3000, () => console.log('🚀 secure server mapping activated at http://localhost:3000'));