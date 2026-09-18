#!/usr/bin/env node
/* =====================================================================
   admin.js — moderator console for Feed a Goose
   =====================================================================
   Run it from the same folder as server.js:

     node admin.js users                       list every account
     node admin.js show <username>             full detail on one account
     node admin.js export [file]               dump all accounts to JSON (default accounts.json)
     node admin.js export-csv [file]           dump all accounts to CSV (default accounts.csv)

     node admin.js add <username> <email> <password>
     node admin.js remove <username>           delete account + their posts/comments/likes
     node admin.js passwd <username> <newpass> reset someone's password
     node admin.js promote <username>          make them a moderator
     node admin.js demote <username>

     node admin.js tokens <username> +5        give 5 tokens
     node admin.js tokens <username> -3        take 3 tokens
     node admin.js tokens <username> =20       set balance to exactly 20

     node admin.js posts [username]            list posts (optionally by one user)
     node admin.js comments [username]         list comments
     node admin.js delpost <id>                delete a post (and its comments/likes)
     node admin.js delcomment <id>

   Passwords are never printed — they're stored as bcrypt hashes and
   can't be read back, only reset.
   ===================================================================== */

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_FILE = './community_wall.db';
const SALT_ROUNDS = 10;

const [, , cmd, ...args] = process.argv;

function pad(s, n) { return String(s ?? '').padEnd(n).slice(0, n); }
function line(n = 92) { console.log('─'.repeat(n)); }

function ageFrom(birthday) {
    if (!birthday) return '—';
    const b = new Date(birthday);
    if (isNaN(b)) return '—';
    const now = new Date();
    let years = now.getFullYear() - b.getFullYear();
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) years--;
    return years < 1 ? '<1 yr' : `${years} yr`;
}

async function main() {
    const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

    const findUser = async (name) => {
        const u = await db.get(`SELECT * FROM users WHERE username = ?`, [name]);
        if (!u) { console.log(`✗ No account named "${name}".`); process.exit(1); }
        return u;
    };

    switch ((cmd || '').toLowerCase()) {

        case 'users':
        case 'list': {
            const users = await db.all(`
                SELECT id, username, email, token_balance, cat_name, breed, country, is_admin, created_at,
                  (SELECT COUNT(*) FROM posts WHERE user_id = users.id) AS posts,
                  (SELECT COUNT(*) FROM comments WHERE user_id = users.id) AS comments
                FROM users ORDER BY id
            `);
            line();
            console.log(pad('ID', 4) + pad('USERNAME', 16) + pad('EMAIL', 26) + pad('CAT', 14) +
                        pad('🐟', 5) + pad('POSTS', 7) + pad('COMM', 6) + 'ROLE');
            line();
            users.forEach(u => {
                console.log(
                    pad(u.id, 4) + pad(u.username, 16) + pad(u.email, 26) + pad(u.cat_name, 14) +
                    pad(u.token_balance, 5) + pad(u.posts, 7) + pad(u.comments, 6) +
                    (u.is_admin ? 'MODERATOR' : 'user')
                );
            });
            line();
            console.log(`${users.length} account(s).`);
            break;
        }

        case 'show': {
            const u = await findUser(args[0]);
            const posts = await db.all(`SELECT id, content, timestamp FROM posts WHERE user_id = ? ORDER BY id DESC`, [u.id]);
            const comments = await db.all(`SELECT id, post_id, content FROM comments WHERE user_id = ? ORDER BY id DESC`, [u.id]);
            line();
            console.log(`  ${u.username}${u.is_admin ? '  [MODERATOR]' : ''}`);
            line();
            console.log(`  id            ${u.id}`);
            console.log(`  email         ${u.email}`);
            console.log(`  tokens        ${u.token_balance}`);
            console.log(`  cat's name    ${u.cat_name || '—'}`);
            console.log(`  breed         ${u.breed || '—'}`);
            console.log(`  birthday      ${u.birthday || '—'}  (${ageFrom(u.birthday)})`);
            console.log(`  country       ${u.country || '—'}`);
            console.log(`  favourite     ${u.fav_food || '—'}`);
            console.log(`  avatar        ${u.avatar || '—'}`);
            console.log(`  joined        ${u.created_at || '—'}`);
            console.log(`  password      [bcrypt hash — not readable]`);
            line();
            console.log(`  ${posts.length} post(s):`);
            posts.forEach(p => console.log(`    #${p.id}  ${String(p.content).slice(0, 60)}`));
            console.log(`  ${comments.length} comment(s):`);
            comments.forEach(c => console.log(`    #${c.id} (on post ${c.post_id})  ${String(c.content).slice(0, 50)}`));
            line();
            break;
        }

        case 'export': {
            const file = args[0] || 'accounts.json';
            const users = await db.all(`
                SELECT id, username, email, token_balance, avatar, cat_name, breed,
                       birthday, country, fav_food, is_admin, created_at
                FROM users ORDER BY id
            `);
            fs.writeFileSync(path.resolve(file), JSON.stringify(users, null, 2));
            console.log(`✓ Wrote ${users.length} account(s) to ${file} (passwords excluded).`);
            break;
        }

        case 'export-csv': {
            const file = args[0] || 'accounts.csv';
            const users = await db.all(`
                SELECT id, username, email, token_balance, avatar, cat_name, breed,
                       birthday, country, fav_food, is_admin, created_at
                FROM users ORDER BY id
            `);
            const cols = Object.keys(users[0] || { id: '', username: '' });
            const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const csv = [cols.join(',')].concat(
                users.map(u => cols.map(c => esc(u[c])).join(','))
            ).join('\n');
            fs.writeFileSync(path.resolve(file), csv);
            console.log(`✓ Wrote ${users.length} account(s) to ${file} (passwords excluded).`);
            break;
        }

        case 'add': {
            const [username, email, password] = args;
            if (!username || !email || !password) {
                console.log('Usage: node admin.js add <username> <email> <password>');
                process.exit(1);
            }
            const hashed = await bcrypt.hash(password, SALT_ROUNDS);
            await db.run(
                `INSERT INTO users (username, email, password, created_at) VALUES (?, ?, ?, ?)`,
                [username, email, hashed, new Date().toISOString()]
            );
            console.log(`✓ Created "${username}" with 20 tokens.`);
            break;
        }

        case 'remove':
        case 'delete': {
            const u = await findUser(args[0]);
            await db.run(`DELETE FROM likes WHERE user_id = ?`, [u.id]);
            await db.run(`DELETE FROM comments WHERE user_id = ?`, [u.id]);
            await db.run(`DELETE FROM posts WHERE user_id = ?`, [u.id]);
            await db.run(`DELETE FROM users WHERE id = ?`, [u.id]);
            console.log(`✓ Removed "${u.username}" and everything they posted.`);
            break;
        }

        case 'passwd': {
            const u = await findUser(args[0]);
            const newPass = args[1];
            if (!newPass) { console.log('Usage: node admin.js passwd <username> <newpassword>'); process.exit(1); }
            const hashed = await bcrypt.hash(newPass, SALT_ROUNDS);
            await db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, u.id]);
            console.log(`✓ Password reset for "${u.username}".`);
            break;
        }

        case 'promote':
        case 'demote': {
            const u = await findUser(args[0]);
            const val = cmd.toLowerCase() === 'promote' ? 1 : 0;
            await db.run(`UPDATE users SET is_admin = ? WHERE id = ?`, [val, u.id]);
            console.log(`✓ "${u.username}" is now ${val ? 'a MODERATOR' : 'a normal user'}.`);
            break;
        }

        case 'tokens': {
            const u = await findUser(args[0]);
            const change = args[1];
            if (!change) { console.log('Usage: node admin.js tokens <username> <+5 | -3 | =20>'); process.exit(1); }

            let next;
            if (change.startsWith('=')) next = parseInt(change.slice(1), 10);
            else next = u.token_balance + parseInt(change, 10);

            if (isNaN(next)) { console.log('✗ Not a number.'); process.exit(1); }
            next = Math.max(0, next);

            await db.run(`UPDATE users SET token_balance = ? WHERE id = ?`, [next, u.id]);
            console.log(`✓ ${u.username}: ${u.token_balance} → ${next} 🐟`);
            break;
        }

        case 'posts': {
            const rows = args[0]
                ? await db.all(`SELECT * FROM posts WHERE username = ? ORDER BY id DESC`, [args[0]])
                : await db.all(`SELECT * FROM posts ORDER BY id DESC`);
            line();
            console.log(pad('ID', 6) + pad('AUTHOR', 16) + pad('WHEN', 22) + 'CONTENT');
            line();
            rows.forEach(p => console.log(
                pad(p.id, 6) + pad(p.username, 16) + pad(p.timestamp, 22) + String(p.content).slice(0, 44)
            ));
            line();
            console.log(`${rows.length} post(s).`);
            break;
        }

        case 'comments': {
            const rows = args[0]
                ? await db.all(`SELECT * FROM comments WHERE username = ? ORDER BY id DESC`, [args[0]])
                : await db.all(`SELECT * FROM comments ORDER BY id DESC`);
            line();
            console.log(pad('ID', 6) + pad('POST', 6) + pad('AUTHOR', 16) + 'CONTENT');
            line();
            rows.forEach(c => console.log(
                pad(c.id, 6) + pad(c.post_id, 6) + pad(c.username, 16) + String(c.content).slice(0, 50)
            ));
            line();
            console.log(`${rows.length} comment(s).`);
            break;
        }

        case 'delpost': {
            const id = args[0];
            const post = await db.get(`SELECT * FROM posts WHERE id = ?`, [id]);
            if (!post) { console.log(`✗ No post #${id}.`); process.exit(1); }
            await db.run(`DELETE FROM comments WHERE post_id = ?`, [id]);
            await db.run(`DELETE FROM likes WHERE post_id = ?`, [id]);
            await db.run(`DELETE FROM posts WHERE id = ?`, [id]);
            if (post.image_url) fs.unlink(path.join(__dirname, post.image_url), () => {});
            console.log(`✓ Deleted post #${id} by ${post.username}.`);
            break;
        }

        case 'delcomment': {
            const id = args[0];
            const c = await db.get(`SELECT * FROM comments WHERE id = ?`, [id]);
            if (!c) { console.log(`✗ No comment #${id}.`); process.exit(1); }
            await db.run(`DELETE FROM comments WHERE id = ?`, [id]);
            console.log(`✓ Deleted comment #${id} by ${c.username}.`);
            break;
        }

        default:
            console.log(fs.readFileSync(__filename, 'utf8').split('=====================================================================')[1]);
    }

    await db.close();
}

main().catch(err => { console.error(err); process.exit(1); });