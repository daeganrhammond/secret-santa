import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { drawRecipients } from './draw.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createApp(config = {}) {
  const password = config.password ?? process.env.ADMIN_PASSWORD;
  if (!password || password.length < 16) throw new Error('Set ADMIN_PASSWORD to at least 16 characters before starting.');
  const origin = config.origin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000';
  const isSecure = origin.startsWith('https:');
  const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 32);
  const dbPath = config.dbPath ?? resolve(root, 'data/santa.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS draw (id INTEGER PRIMARY KEY CHECK(id=1), assignments TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (participant_id TEXT PRIMARY KEY REFERENCES participants(id), status TEXT NOT NULL, attempted_at TEXT, provider_id TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);`);
  // A process exit during a send leaves an uncertain outcome; never silently resend.
  db.prepare("UPDATE deliveries SET status='review' WHERE status='sending'").run();
  const ready = () => Boolean(config.sendEmail || (process.env.RESEND_API_KEY && process.env.EMAIL_FROM));
  const sendEmail = config.sendEmail ?? (async ({ email, name, recipients, key }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: `${process.env.EVENT_NAME || 'Secret Santa'}: your two names 🎄`,
        text: `Hi ${name}!\n\nYour Secret Santa recipients are:\n\n1. ${recipients[0]}\n2. ${recipients[1]}\n\nPlease buy one gift for each person. Keep your names a secret!\n\nEveryone is giving two gifts and receiving two gifts. Happy holidays!` })
    });
    if (!response.ok) { const error = new Error('The email provider rejected this request.'); error.definiteFailure = response.status < 500 && response.status !== 408 && response.status !== 409; throw error; }
    const result = await response.json();
    if (!result.id) throw new Error('Email provider did not return a receipt.');
    return result.id;
  });
  const participants = () => db.prepare('SELECT id,name,email FROM participants ORDER BY rowid').all();
  const getDraw = () => db.prepare('SELECT * FROM draw WHERE id=1').get();
  function limited(key, max) {
    const now = Date.now();
    db.prepare('DELETE FROM limits WHERE resets_at < ?').run(now);
    const entry = db.prepare('SELECT * FROM limits WHERE key=?').get(key);
    if (entry && entry.count >= max) throw new HttpError(429, 'Too many attempts. Please try again in 15 minutes.');
    db.prepare('INSERT INTO limits(key,count,resets_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 900000);
  }
  function admin(req) {
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('santa_admin='));
    const sessionToken = cookie?.slice('santa_admin='.length) || '';
    const session = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(hash(sessionToken));
    if (!session || session.expires_at < Date.now()) throw new HttpError(401, 'Please sign in as the organizer.');
  }
  async function body(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4096) throw new HttpError(413, 'Request is too large.');
    }
    try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
  }
  let mailing = false;
  async function deliver() {
    if (mailing) throw new HttpError(409, 'Emails are already being sent.');
    mailing = true;
    try {
      const draw = getDraw(), assignments = JSON.parse(draw.assignments), people = participants();
      const byId = Object.fromEntries(people.map(p => [p.id, p]));
      for (const person of people) {
        const claim = db.prepare("UPDATE deliveries SET status='sending', attempted_at=? WHERE participant_id=? AND status IN ('pending','failed')").run(new Date().toISOString(), person.id);
        if (!claim.changes) continue;
        try {
          const providerId = await sendEmail({ email: person.email, name: person.name,
            recipients: assignments[person.id].map(id => byId[id].name), key: `santa-${person.id}-${hash(draw.created_at).slice(0,16)}` });
          db.prepare("UPDATE deliveries SET status='sent',provider_id=? WHERE participant_id=?").run(providerId, person.id);
        } catch (error) {
          db.prepare('UPDATE deliveries SET status=? WHERE participant_id=?').run(error.definiteFailure ? 'failed' : 'review', person.id);
        }
      }
    } finally { mailing = false; }
  }
  function organizerState() {
    const drawn = Boolean(getDraw());
    return { drawn, emailReady: ready(), people: participants().map(p => ({ ...p,
      status: db.prepare('SELECT status FROM deliveries WHERE participant_id=?').get(p.id)?.status || 'joined' })) };
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(data));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' https://script.google.com https://script.googleusercontent.com; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) throw new HttpError(403, 'Please use the app to submit this request.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON is required.');
      }
      if (req.method === 'GET' && path === '/api/status') return reply(200, { count: participants().length, drawn: Boolean(getDraw()) });
      if (req.method === 'POST' && path === '/api/receipt') {
        const data = await body(req);
        const person = typeof data.receipt === 'string' ? db.prepare('SELECT name FROM participants WHERE receipt=?').get(hash(data.receipt)) : null;
        return reply(200, { joined: Boolean(person), name: person?.name });
      }
      if (req.method === 'POST' && path === '/api/join') {
        limited(`join:${req.socket.remoteAddress}`, 30);
        const data = await body(req), name = typeof data.name === 'string' ? data.name.trim().replace(/\s+/g, ' ') : '',
          email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, 'Please enter a name of 1–60 characters.');
        if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (getDraw()) throw new HttpError(409, 'The draw has already happened.');
          if (participants().length >= 6) throw new HttpError(409, 'All six places are filled.');
          if (db.prepare('SELECT id FROM participants WHERE email=?').get(email)) throw new HttpError(409, 'That email address has already joined.');
          if (db.prepare('SELECT id FROM participants WHERE lower(name)=lower(?)').get(name)) throw new HttpError(409, 'That name is already in use. Add a last name or initial.');
          const receipt = token();
          db.prepare('INSERT INTO participants VALUES (?,?,?,?)').run(token(), name, email, hash(receipt));
          db.exec('COMMIT');
          return reply(201, { joined: true, name, receipt });
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
      if (req.method === 'POST' && path === '/api/login') {
        limited(`login:${req.socket.remoteAddress}`, 10);
        const data = await body(req);
        const candidate = typeof data.password === 'string' && data.password.length <= 512 ? data.password : '';
        if (!timingSafeEqual(scryptSync(candidate, salt, 32), passwordHash)) throw new HttpError(401, 'That organizer password is incorrect.');
        const session = token();
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash(session), Date.now() + 8 * 3600000);
        return reply(200, { ok: true }, { 'Set-Cookie': `santa_admin=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${isSecure ? '; Secure' : ''}` });
      }
      if (path.startsWith('/api/admin')) {
        admin(req);
        if (req.method === 'GET' && path === '/api/admin') return reply(200, organizerState());
        if (req.method === 'POST' && path === '/api/admin/logout') {
          const cookie = req.headers.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('santa_admin='));
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(cookie.slice('santa_admin='.length)));
          return reply(200, { ok: true }, { 'Set-Cookie': 'santa_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }
        if (req.method === 'POST' && path === '/api/admin/remove') {
          const data = await body(req);
          if (getDraw()) throw new HttpError(409, 'Participants are locked after the draw.');
          db.prepare('DELETE FROM participants WHERE id=?').run(data.id || '');
          return reply(200, organizerState());
        }
        if (req.method === 'POST' && path === '/api/admin/draw') {
          if (!ready()) throw new HttpError(503, 'Connect an email sender before running the draw.');
          db.exec('BEGIN IMMEDIATE');
          try {
            if (getDraw()) throw new HttpError(409, 'The draw is already saved. Use Retry failed emails if needed.');
            const people = participants();
            if (people.length !== 6) throw new HttpError(409, 'All six people must join first.');
            const assignments = drawRecipients(people.map(p => p.id));
            db.prepare('INSERT INTO draw VALUES (1,?,?)').run(JSON.stringify(assignments), new Date().toISOString());
            for (const person of people) db.prepare("INSERT INTO deliveries(participant_id,status) VALUES (?,'pending')").run(person.id);
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          await deliver();
          return reply(200, organizerState());
        }
        if (req.method === 'POST' && path === '/api/admin/retry') {
          if (!ready() || !getDraw()) throw new HttpError(409, 'An email sender and saved draw are required.');
          await deliver();
          return reply(200, organizerState());
        }
      }
      const assets = { '/': ['index.html','text/html'], '/organizer': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/config.js': ['config.js','text/javascript'], '/style.css': ['style.css','text/css'] };
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(readFileSync(resolve(root, 'public', file)));
      }
      reply(404, { error: 'Page not found.' });
    } catch (error) { reply(error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' }); }
  });
  return { server, db, close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`Secret Santa ready at ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}`));
}
