'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const http = require('http');
const WebSocket = require('ws');
const helmet = require("helmet");

const app = express();
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));

const PORT = 3002;
const MUSIC_DIR = '/home/sky0401/music';
// ── yt-dlp direct download config ──
const YTDLP_BIN = '/usr/local/bin/yt-dlp';
const YTDLP_ARCHIVE = '/srv/www/laowudiy/l5music-core/yt-dlp-archive.txt';
const DEST_DIRS = { default: MUSIC_DIR, pop: path.join(MUSIC_DIR, 'pop'), boost: path.join(MUSIC_DIR, 'boost'), littlestar: path.join(MUSIC_DIR, 'littlestar') };
const ytJobs = new Map();
const VERSION = 'b49';
const DATA_DIR = path.join(__dirname, 'data');
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } });

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── PERSISTENCE HELPERS ─────────────────────────────────────────────────────
function loadData(file, fallback) {
  const p = path.join(DATA_DIR, file);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveData(file, data) {
  const p = path.join(DATA_DIR, file);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// ─── IN-MEMORY STORE ─────────────────────────────────────────────────────────
let library   = [];
let queue     = loadData('queue.json', []);
let history   = loadData('history.json', []);
let playlists = loadData('playlists.json', []);
let users     = loadData('users.json', []);
let sessions  = loadData('sessions.json', {});
// ── SIGNUP DATA ──
let pendingSignups = loadData('pending_signups.json', []);
let setupTokens = loadData('setup_tokens.json', {});
const SIGNUP_RATE = {};
const SIGNUP_RATE_MAX = 3;
const SETUP_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

function generateSetupToken() {
  return crypto.randomBytes(32).toString('hex');
}


// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

function getSessionUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    delete sessions[token];
    saveData('sessions.json', sessions);
    return null;
  }
  return session.username;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  req.username = user;
  next();
}

function requireAdmin(req, res, next) {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const user = users.find(u => u.username === username);
  if (!user || user.role !== 'admin' && user.role !== 'owner') return res.status(403).json({ ok: false, error: 'Admin only' });
  req.username = username;
  next();
}

function requireOwner(req, res, next) {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const user = users.find(u => u.username === username);
  if (!user || user.role !== "owner") return res.status(403).json({ ok: false, error: "Owner only" });
  req.username = username;
  next();
}

// ─── LIBRARY ─────────────────────────────────────────────────────────────────
function makeId(relPath) {
  let hash = 0;
  for (let i = 0; i < relPath.length; i++) {
    hash = (hash << 5) - hash + relPath.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

async function scanLibrary() {
  const exts = ['.mp3', '.flac', '.m4a', '.opus', '.ogg', '.wav'];
  const found = [];

  function walkDir(dir, relBase) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relBase, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (exts.includes(path.extname(entry.name).toLowerCase())) {
        found.push({ id: makeId(relPath), path: relPath, fullPath });
      }
    }
  }

  walkDir(MUSIC_DIR, '');

  for (const song of found) {
    try {
      const meta = await mm.parseFile(song.fullPath, { duration: true, skipCovers: false });
      song.title    = meta.common.title  || path.basename(song.path, path.extname(song.path));
      song.artist   = meta.common.artist || 'Unknown';
      song.album    = meta.common.album  || 'Unknown';
      song.duration = Math.round(meta.format.duration || 0);
      song.hasCover = !!(meta.common.picture && meta.common.picture.length > 0);
    } catch {
      song.title    = path.basename(song.path, path.extname(song.path));
      song.artist   = 'Unknown';
      song.album    = 'Unknown';
      song.duration = 0;
      song.hasCover = false;
    }
  }

  library = found;
  console.log(`[l5music-core] Scanned ${library.length} songs`);
}

async function scanFolder(dir) {
  const exts = ['.mp3', '.flac', '.m4a', '.opus', '.ogg', '.wav'];
  const existingPaths = new Set(library.map(s => s.fullPath));
  const relBase = path.relative(MUSIC_DIR, dir);
  let added = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !exts.includes(path.extname(entry.name).toLowerCase())) continue;
      const fullPath = path.join(dir, entry.name);
      if (existingPaths.has(fullPath)) continue;
      const relPath = path.join(relBase, entry.name).replace(/\\/g, '/');
      const song = { id: makeId(relPath), path: relPath, fullPath };
      try {
        const meta = await mm.parseFile(fullPath, { duration: true, skipCovers: false });
        song.title = meta.common.title || path.basename(relPath, path.extname(relPath));
        song.artist = meta.common.artist || 'Unknown';
        song.album = meta.common.album || 'Unknown';
        song.duration = Math.round(meta.format.duration || 0);
        song.hasCover = !!(meta.common.picture && meta.common.picture.length > 0);
      } catch {
        song.title = path.basename(relPath, path.extname(relPath));
        song.artist = 'Unknown'; song.album = 'Unknown'; song.duration = 0; song.hasCover = false;
      }
      library.push(song);
      added++;
    }
  } catch(e) { console.error('[scanFolder] error:', e.message); }
  if (added) console.log('[l5music-core] scanFolder added', added, 'songs from', relBase || '/');
  return added;
}

// ─── ROUTES: PUBLIC ───────────────────────────────────────────────────────────

app.get('/ping', (req, res) => {
  res.json({ ok: true });
});

app.get('/folders', (req, res) => {
  const fs = require('fs'), path = require('path');
  try {
    const dirs = fs.readdirSync(MUSIC_DIR, {withFileTypes:true})
      .filter(d => d.isDirectory())
      .map(d => d.name);
    res.json({ ok: true, folders: ['default', ...dirs] });
  } catch(e) { res.json({ ok: true, folders: ['default'] }); }
});

// ─── LOGIN RATE LIMITING ──────────────────────────────────────────────────────
// Per-IP tracking: 3 fails → IP locked 30 min (phase 1)
// After IP lock expires: 3 more fails → account permanently locked (phase 2)
const loginAttempts = {};
const { execSync } = require('child_process');


const IP_LOCK_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const IP_WHITELIST = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
  const isWhitelisted = IP_WHITELIST.includes(ip) || ip.startsWith("192.168.") || ip.startsWith("::ffff:192.168.");
  const now = Date.now();

  if (!isWhitelisted) {
    if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lockedUntil: 0, phase: 1 };
    const att = loginAttempts[ip];

    // Currently IP-locked?
    if (att.lockedUntil && now < att.lockedUntil) {
      const minsLeft = Math.ceil((att.lockedUntil - now) / 60000);
      return res.status(429).json({ ok: false, error: `Too many failed attempts. Try again in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.` });
    }

    // IP lock just expired → reset count, advance to phase 2
    if (att.lockedUntil && now >= att.lockedUntil) {
      att.count = 0;
      att.lockedUntil = 0;
      att.phase = 2;
    }
  }

  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  // Account locked? (still applies to whitelisted IPs)
  if (user && user.accountLocked) {
    return res.status(403).json({ ok: false, error: 'Account locked. Contact admin.' });
  }

  const match = user && await bcrypt.compare(password, user.passwordHash);

  if (!user || !match) {
    if (!isWhitelisted) {
      const att = loginAttempts[ip];
      att.count++;
      if (att.count >= MAX_ATTEMPTS) {
        if (att.phase === 2 && user) {
          user.accountLocked = true;
          saveData('users.json', users);
          att.count = 0;
          att.lockedUntil = 0;
          return res.status(403).json({ ok: false, error: 'Account locked due to too many failed attempts. Contact admin.' });
        } else {
          att.lockedUntil = now + IP_LOCK_MS;
          att.count = 0;
          return res.status(429).json({ ok: false, error: 'Too many failed attempts. IP locked for 30 minutes.' });
        }
      }
      const remaining = MAX_ATTEMPTS - att.count;
      return res.status(401).json({ ok: false, error: `Invalid username or password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
    }
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }

  // Success — clear rate limit for this IP
  if (!isWhitelisted) delete loginAttempts[ip];

  user.lastLoginAt = Date.now();
  saveData('users.json', users);
  const token = generateToken();
  sessions[token] = {
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000),
  };
  saveData('sessions.json', sessions);
  // Cap sessions per user at 10 — remove oldest
  const MAX_SESSIONS = 10;
  const userSessions = Object.entries(sessions).filter(([,s]) => s.username === user.username).sort((a,b) => a[1].createdAt - b[1].createdAt);
  while (userSessions.length > MAX_SESSIONS) { const [oldToken] = userSessions.shift(); delete sessions[oldToken]; }
  res.json({ ok: true, token, username: user.username, role: user.role || 'user' });
});

// ─── ROUTES: BLOCKED SONGS ───────────────────────────────────────────────────

app.get('/blocked', requireAuth, (req, res) => {
  const user = req.query.user;
  if (!user) return res.status(400).json({ ok: false, error: 'user required' });
  const data = loadData('blocked_' + user.replace(/[^a-z0-9]/gi,'_') + '.json', { blocked: [] });
  res.json({ ok: true, blocked: data.blocked });
});

app.post('/blocked', requireAuth, (req, res) => {
  const { user, songId } = req.body;
  if (!user || songId === undefined) return res.status(400).json({ ok: false, error: 'user and songId required' });
  const key = 'blocked_' + user.replace(/[^a-z0-9]/gi,'_') + '.json';
  const data = loadData(key, { blocked: [] });
  if (!data.blocked.includes(songId)) data.blocked.push(songId);
  saveData(key, data);
  res.json({ ok: true });
});

app.delete('/blocked', requireAuth, (req, res) => {
  const { user, songId } = req.body;
  if (!user || songId === undefined) return res.status(400).json({ ok: false, error: 'user and songId required' });
  const key = 'blocked_' + user.replace(/[^a-z0-9]/gi,'_') + '.json';
  const data = loadData(key, { blocked: [] });
  data.blocked = data.blocked.filter(id => id !== songId);
  saveData(key, data);
  res.json({ ok: true });
});

// ─── ROUTES: SHUFFLE LOG ─────────────────────────────────────────────────────

app.get('/shuffle-log', requireAuth, (req, res) => {
  const user = req.query.user;
  if (!user) return res.status(400).json({ ok: false, error: 'user required' });
  const data = loadData('shuffle_' + user.replace(/[^a-z0-9]/gi,'_') + '.json', { played: [] });
  res.json({ ok: true, played: data.played });
});

app.post('/shuffle-log', requireAuth, (req, res) => {
  const { user, songId, totalSongs } = req.body;
  if (!user || songId === undefined) return res.status(400).json({ ok: false, error: 'user and songId required' });
  const key = 'shuffle_' + user.replace(/[^a-z0-9]/gi,'_') + '.json';
  const data = loadData(key, { played: [] });
  if (!data.played.includes(songId)) data.played.push(songId);
  let reset = false;
  if (totalSongs && data.played.length >= totalSongs) { data.played = []; reset = true; }
  saveData(key, data);
  res.json({ ok: true, reset });
});

app.delete('/shuffle-log', requireAuth, (req, res) => {
  const { user } = req.body;
  if (!user) return res.status(400).json({ ok: false, error: 'user required' });
  const key = 'shuffle_' + user.replace(/[^a-z0-9]/gi,'_') + '.json';
  saveData(key, { played: [] });
  res.json({ ok: true });
});

// ─── ROUTES: BUG/REQUEST REPORT ──────────────────────────────────────────────

app.post('/send-report', requireAuth, (req, res) => {
  const { message } = req.body;
  const user = req.username;
  if (!message || !message.trim()) return res.status(400).json({ ok: false, error: 'empty' });
  mailer.sendMail({
    from: GMAIL_USER,
    to: GMAIL_USER,
    subject: `[L5Music] Bug/Request from ${user}`,
    text: `User: ${user}\n\n${message}`
  }, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

// ─── ROUTES: PROTECTED ───────────────────────────────────────────────────────

app.post('/logout', requireAuth, (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token && sessions[token]) {
    delete sessions[token];
    saveData('sessions.json', sessions);
  }
  res.json({ ok: true });
});

app.get('/me', requireAuth, (req, res) => {
  const user = users.find(u => u.username === req.username);
  res.json({ ok: true, username: req.username, role: user ? (user.role === 'owner' ? 'admin' : (user.role || 'user')) : 'user', isOwner: user ? user.role === 'owner' : false });
});

app.get('/rescan', requireAuth, async (req, res) => {
  await scanLibrary();
  res.json({ ok: true, songs: library.length });
});

app.get('/songs', requireAuth, (req, res) => {
  let songs = library;

  if (req.query.folder === 'pop') {
    songs = songs.filter(s => s.path.startsWith('pop/'));
  } else if (req.query.folder === 'boost') {
    songs = songs.filter(s => s.path.startsWith('boost/'));
  } else if (req.query.folder === 'littlestar') {
    songs = songs.filter(s => s.path.startsWith('littlestar/'));
  } else if (!req.query.folder || req.query.folder === 'default') {
    songs = songs.filter(s => !s.path.includes('/'));
  }

  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    songs = songs.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.album.toLowerCase().includes(q)
    );
  }

  if (req.query.artist) {
    songs = songs.filter(s => s.artist.toLowerCase() === req.query.artist.toLowerCase());
  }

  if (req.query.album) {
    songs = songs.filter(s => s.album.toLowerCase() === req.query.album.toLowerCase());
  }

  res.json({
    ok: true,
    total: songs.length,
    songs: songs.map(s => ({
      id: s.id, title: s.title, artist: s.artist,
      album: s.album, duration: s.duration, path: s.path, hasCover: s.hasCover
    }))
  });
});

app.get('/songs/:id', requireAuth, (req, res) => {
  const song = library.find(s => s.id === parseInt(req.params.id));
  if (!song) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, song: {
    id: song.id, title: song.title, artist: song.artist,
    album: song.album, duration: song.duration, path: song.path, hasCover: song.hasCover
  }});
});

app.delete("/songs/:id", requireAdmin, (req, res) => {
  const song = library.find(s => s.id === parseInt(req.params.id));
  if (!song) return res.status(404).json({ ok: false, error: "not found" });
  try {
    fs.unlinkSync(song.fullPath);
    library = library.filter(s => s.id !== song.id);
    console.log("[l5music-core] Deleted:", song.path);
    res.json({ ok: true, deleted: song.path });
  } catch (e) {
    console.error("[l5music-core] Delete failed:", e.message);
    res.status(500).json({ ok: false, error: "Failed to delete file" });
  }
});

app.get('/random', requireAuth, (req, res) => {
  const size = Math.min(parseInt(req.query.size) || 50, 500);
  let pool = library;

  if (req.query.folder === 'pop') {
    pool = pool.filter(s => s.path.startsWith('pop/'));
  } else if (req.query.folder === 'boost') {
    pool = pool.filter(s => s.path.startsWith('boost/'));
  } else if (req.query.folder === 'littlestar') {
    pool = pool.filter(s => s.path.startsWith('littlestar/'));
  } else if (!req.query.folder || req.query.folder === 'default') {
    pool = pool.filter(s => !s.path.includes('/'));
  }

  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  const songs = arr.slice(0, size).map(s => ({
    id: s.id, title: s.title, artist: s.artist,
    album: s.album, duration: s.duration, path: s.path, hasCover: s.hasCover
  }));

  res.json({ ok: true, total: songs.length, songs });
});

app.get('/artists', requireAuth, (req, res) => {
  const set = {};
  for (const s of library) {
    if (!set[s.artist]) set[s.artist] = 0;
    set[s.artist]++;
  }
  const artists = Object.entries(set)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, total: artists.length, artists });
});

app.get('/albums', requireAuth, (req, res) => {
  const set = {};
  for (const s of library) {
    if (!set[s.album]) set[s.album] = { name: s.album, artist: s.artist, count: 0 };
    set[s.album].count++;
  }
  const albums = Object.values(set).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, total: albums.length, albums });
});

// ─── ROUTES: STREAM & COVER ──────────────────────────────────────────────────

app.get('/stream', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const username = getSessionUser({ headers: { authorization: 'Bearer ' + token } });
  if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const song = library.find(s => s.id === parseInt(req.query.id));
  if (!song) return res.status(404).json({ ok: false, error: 'not found' });

  const stat = fs.statSync(song.fullPath);
  const ext = path.extname(song.fullPath).toLowerCase();
  const mime = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
  }[ext] || 'audio/mpeg';

  const range = req.headers.range;
  if (range) {
    const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
    const chunkEnd = end || Math.min(start + 1024 * 1024, stat.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${chunkEnd}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkEnd - start + 1,
      'Content-Type': mime
    });
    fs.createReadStream(song.fullPath, { start, end: chunkEnd }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(song.fullPath).pipe(res);
  }
});

app.get('/cover', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  const username = getSessionUser({ headers: { authorization: 'Bearer ' + token } });
  if (!username) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const song = library.find(s => s.id === parseInt(req.query.id));
  if (!song) return res.status(404).json({ ok: false, error: 'not found' });
  try {
    const meta = await mm.parseFile(song.fullPath, { skipCovers: false });
    const pic = meta.common.picture && meta.common.picture[0];
    if (!pic) return res.status(404).json({ ok: false, error: 'no cover' });
    res.writeHead(200, {
      'Content-Type': pic.format,
      'Content-Length': pic.data.length,
      'Cache-Control': 'public, max-age=86400'
    });
    res.end(pic.data);
  } catch {
    res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ─── ROUTES: QUEUE ───────────────────────────────────────────────────────────

app.post('/queue', requireAuth, (req, res) => {
  const { songs } = req.body;
  if (!Array.isArray(songs)) return res.status(400).json({ ok: false, error: 'songs must be array' });
  queue = songs;
  saveData('queue.json', queue);
  res.json({ ok: true, count: queue.length });
});

app.get('/queue', requireAuth, (req, res) => {
  const songs = queue.map(id => {
    const s = library.find(x => x.id === id);
    return s ? { id: s.id, title: s.title, artist: s.artist, duration: s.duration, hasCover: s.hasCover } : null;
  }).filter(Boolean);
  res.json({ ok: true, count: songs.length, songs });
});

// ─── ROUTES: HISTORY ─────────────────────────────────────────────────────────

app.post('/history', requireAuth, (req, res) => {
  const { id } = req.body;
  const song = library.find(s => s.id === parseInt(id));
  if (!song) return res.status(404).json({ ok: false, error: 'not found' });
  history.unshift({ id: song.id, title: song.title, artist: song.artist, playedAt: Date.now() });
  if (history.length > 100) history = history.slice(0, 100);
  saveData('history.json', history);
  res.json({ ok: true });
});

app.get('/history', requireAuth, (req, res) => {
  res.json({ ok: true, count: history.length, history });
});

// ─── ROUTES: PLAYLISTS ───────────────────────────────────────────────────────

app.get('/playlists', requireAuth, (req, res) => {
  // Always re-hydrate from disk so desktop UI sees playlists
  // even if the in-memory array was empty at startup.
  playlists = loadData('playlists.json', playlists);
  res.json({
    ok: true,
    total: playlists.length,
    playlists: playlists.map(p => ({
      id: p.id,
      name: p.name,
      count: Array.isArray(p.songs) ? p.songs.length : 0,
      createdAt: p.createdAt
    }))
  });
});

app.post('/playlists', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'name required' });
  const playlist = { id: Date.now(), name: name.trim(), songs: [], createdAt: Date.now() };
  playlists.push(playlist);
  saveData('playlists.json', playlists);
  res.json({ ok: true, playlist });
});

app.get('/playlists/:id', requireAuth, (req, res) => {
  const pl = playlists.find(p => p.id === parseInt(req.params.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'not found' });
  const songs = pl.songs.map(id => {
    const s = library.find(x => x.id === id);
    return s ? { id: s.id, title: s.title, artist: s.artist, album: s.album, duration: s.duration, hasCover: s.hasCover } : null;
  }).filter(Boolean);
  res.json({ ok: true, playlist: { id: pl.id, name: pl.name, createdAt: pl.createdAt, songs } });
});

app.put('/playlists/:id', requireAuth, (req, res) => {
  const pl = playlists.find(p => p.id === parseInt(req.params.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'not found' });
  if (req.body.name !== undefined) pl.name = req.body.name.trim();
  if (Array.isArray(req.body.songs)) pl.songs = req.body.songs;
  saveData('playlists.json', playlists);
  res.json({ ok: true, playlist: { id: pl.id, name: pl.name, count: pl.songs.length } });
});

app.delete('/playlists/:id', requireAuth, (req, res) => {
  const idx = playlists.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ ok: false, error: 'not found' });
  playlists.splice(idx, 1);
  saveData('playlists.json', playlists);
  res.json({ ok: true });
});

// POST /change-password — authenticated user changes their own password
app.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Both fields required' });
  if(newPassword.length<6)return res.status(400).json({ok:false,error:'Password must be at least 6 characters.'});if(!/[^A-Za-z0-9]/.test(newPassword))return res.status(400).json({ok:false,error:'Password must contain at least 1 special character.'});
  const user = users.find(u => u.username === req.username);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  const match = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!match) return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  saveData('users.json', users);
  res.json({ ok: true });
});

// ─── ROUTES: ADMIN ───────────────────────────────────────────────────────────

// GET /admin/sessions — who's currently logged in
app.get('/admin/sessions', requireAdmin, (req, res) => {
  const now = Date.now();
  const token = (req.headers['authorization'] || '').slice(7);
  const active = Object.entries(sessions)
    .filter(([, s]) => s.expiresAt > now)
    .map(([tok, s]) => ({
      username: s.username,
      loginAt: s.createdAt,
      expiresAt: s.expiresAt,
      ip: s.ip || null,
      isCurrent: tok === token
    }))
    .sort((a, b) => b.loginAt - a.loginAt);
  res.json({ ok: true, sessions: active });
});

// GET /admin/users — all users
app.get('/admin/users', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    users: users.map(u => ({
      username: u.username,
      role: u.role === 'owner' ? 'admin' : (u.role || 'user'),
      email: u.email || '',
      status: u.status || 'active',
      accountLocked: !!u.accountLocked,
      createdAt: u.createdAt || null,
      lastLoginAt: u.lastLoginAt || null
    }))
  });
});

// POST /admin/users — create user
app.post('/admin/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ ok: false, error: 'User already exists' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const newUser = { username, passwordHash, role: role || 'user', createdAt: Date.now() };
  users.push(newUser);
  saveData('users.json', users);
  res.json({ ok: true, username, role: newUser.role });
});

// DELETE /admin/users/:username
app.delete('/admin/users/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  if (username === req.username) return res.status(400).json({ ok: false, error: 'Cannot delete yourself' });
  const target = users.find(u => u.username === username);
  if (target && target.role === 'owner') return res.status(403).json({ ok: false, error: 'Cannot delete owner' });
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'User not found' });
  users.splice(idx, 1);
  saveData('users.json', users);
  Object.keys(sessions).forEach(t => {
    if (sessions[t].username === username) delete sessions[t];
  });
  saveData('sessions.json', sessions);

  // Also remove from Filebrowser
  try {
    execSync('docker stop filebrowser', { timeout: 15000, stdio: 'pipe' });
    try {
      const fbLs = execSync('docker run --rm -v /mnt/backup/docker/filebrowser/database:/database filebrowser/filebrowser users ls --database=/database/filebrowser.db', { timeout: 15000, stdio: 'pipe' }).toString();
      const userLine = fbLs.split('\n').find(l => l.includes(username));
      if (userLine) {
        const fbId = userLine.trim().split(/\s+/)[0];
        execSync(`docker run --rm -v /mnt/backup/docker/filebrowser/database:/database filebrowser/filebrowser users rm ${fbId} --database=/database/filebrowser.db`, { timeout: 15000, stdio: 'pipe' });
      }
    } catch (fbErr) { console.error('Filebrowser delete error:', fbErr.message); }
    execSync('docker start filebrowser', { timeout: 15000, stdio: 'pipe' });
  } catch (e) {
    console.error('Filebrowser sync error on delete:', e.message);
    try { execSync('docker start filebrowser', { timeout: 10000, stdio: 'pipe' }); } catch {}
  }

  res.json({ ok: true });
});

// PATCH /admin/users/:username — update role, reset password, or unlock account
app.patch('/admin/users/:username', requireAdmin, async (req, res) => {
  const user = users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  if (req.body.role) { const caller = users.find(u => u.username === req.username); if (!caller || caller.role !== "owner") return res.status(403).json({ ok: false, error: "Only owner can change roles" }); if (req.body.role === "owner") return res.status(403).json({ ok: false, error: "Cannot assign owner role" }); user.role = req.body.role; }
  if (req.body.password) { if (req.body.password.length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." }); user.passwordHash = await bcrypt.hash(req.body.password, 12); }
  if (req.body.accountLocked === false) user.accountLocked = false;
  if (req.body.status) user.status = req.body.status;
  if (req.body.email) user.email = req.body.email;
  saveData('users.json', users);
  res.json({ ok: true });
});




// ── SIGNUP: email only (public, rate-limited) ──
app.post('/signup', (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ ok: false, error: 'Valid email address required.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!SIGNUP_RATE[ip]) SIGNUP_RATE[ip] = { count: 0, resetAt: now + 3600000 };
  const sr = SIGNUP_RATE[ip];
  if (now > sr.resetAt) { sr.count = 0; sr.resetAt = now + 3600000; }
  if (sr.count >= SIGNUP_RATE_MAX)
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });

  if (pendingSignups.find(p => p.email.toLowerCase() === email.toLowerCase()))
    return res.status(400).json({ ok: false, error: 'This email is already pending approval.' });
  if (users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()))
    return res.status(400).json({ ok: false, error: 'An account with this email already exists.' });

  sr.count++;
  pendingSignups.push({ email, ip, createdAt: Date.now() });
  saveData('pending_signups.json', pendingSignups);
  mailer.sendMail({ from: GMAIL_USER, to: GMAIL_USER, subject: 'New LaowuDIY Signup Request', html: '<p>New signup request from: <b>' + email + '</b></p><p>IP: ' + ip + '</p><p>Go to <a href="https://monitor.laowudiy.com">Monitor</a> to approve or reject.</p>' }).catch(e => console.error('Signup notify email failed:', e.message));
  res.json({ ok: true, message: 'Request submitted! You will receive an email when approved.' });
});

// ── YT-DLP direct download ──
app.post('/ytmp3/start', requireAuth, (req, res) => {
  const { url, dest } = req.body || {};
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ ok: false, error: 'Valid URL required.' });
  }
  const musicDir = DEST_DIRS[dest] || DEST_DIRS.default;
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = {
    phase: 'starting', done: false, error_message: '',
    total_tracks: 1, completed_tracks: 0,
    current_track_title: '', completed_titles: [],
    stage_label: 'Starting download...'
  };
  ytJobs.set(jobId, job);

  const isPlaylist = /[?&]list=/.test(url);
  const args = [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--convert-thumbnails', 'jpg', '--embed-thumbnail', '--add-metadata',
    '--ppa', 'EmbedThumbnail+ffmpeg:-id3v2_version 3 -write_id3v1 1',
    '--no-overwrites',
    '--download-archive', YTDLP_ARCHIVE,
    '--newline',
    '-o', path.join(musicDir, '%(title)s.%(ext)s'),
  ];
  if (!isPlaylist) args.push('--no-playlist');
  args.push(url.trim());

  console.log('[ytdlp] job', jobId, isPlaylist ? 'playlist' : 'single', url.slice(0, 80));
  job.phase = 'downloading';
  job.stage_label = 'Downloading...';

  const proc = spawn(YTDLP_BIN, args, { cwd: musicDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let lastTitle = '';

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      const destMatch = line.match(/\[ExtractAudio\] Destination:\s*(.+)/);
      if (destMatch) {
        lastTitle = path.basename(destMatch[1]).replace(/\.\w+$/, '');
      }
      const dlMatch = line.match(/\[download\]\s+Destination:\s*(.+)/);
      if (dlMatch) {
        job.current_track_title = path.basename(dlMatch[1]).replace(/\.\w+$/, '');
        job.stage_label = 'Downloading: ' + job.current_track_title;
      }
      if (/has already been (downloaded|recorded)/i.test(line)) {
        job.stage_label = 'Already in library, skipping...';
      }
      const itemMatch = line.match(/\[download\] Downloading item (\d+) of (\d+)/i);
      if (itemMatch) {
        job.total_tracks = parseInt(itemMatch[2], 10);
        const itemNum = parseInt(itemMatch[1], 10);
        if (itemNum > 1 && lastTitle && !job.completed_titles.includes(lastTitle)) {
          job.completed_titles.push(lastTitle);
          job.completed_tracks = job.completed_titles.length;
        }
        job.stage_label = 'Downloading ' + itemNum + '/' + job.total_tracks + '...';
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error('[ytdlp err]', jobId, msg);
  });

  proc.on('close', (code) => {
    if (lastTitle && !job.completed_titles.includes(lastTitle)) {
      job.completed_titles.push(lastTitle);
      job.completed_tracks = job.completed_titles.length;
    }
    if (code === 0) {
      job.phase = 'done'; job.done = true;
      job.stage_label = job.total_tracks > 1
        ? 'Done! Saved ' + job.completed_tracks + ' track(s).'
        : 'Done! Saved to library.';
      scanFolder(musicDir).catch(e => console.error('[scanFolder] post-download error:', e.message));
    } else {
      job.phase = 'error'; job.done = true;
      job.error_message = job.error_message || 'yt-dlp exited with code ' + code;
      job.stage_label = 'Failed';
    }
    console.log('[ytdlp] job', jobId, job.phase, 'tracks:', job.completed_tracks);
    setTimeout(() => ytJobs.delete(jobId), 600000);
  });

  res.json({ ok: true, job_id: jobId });
});

app.get('/ytmp3/status', requireAuth, (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Missing job id.' });
  const job = ytJobs.get(id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });
  res.json({ ok: true, status: job });
});

// ── GET pending signups (admin) ──
app.get('/admin/pending', requireAdmin, (req, res) => {
  res.json({ ok: true, pending: pendingSignups });
});

// ── APPROVE signup → generate token + email setup link (admin) ──
app.post('/admin/approve-signup', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
  const idx = pendingSignups.findIndex(p => p.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Pending signup not found' });

  const token = generateSetupToken();
  setupTokens[token] = { email, type: 'signup', createdAt: Date.now(), expiresAt: Date.now() + SETUP_TOKEN_TTL };
  saveData('setup_tokens.json', setupTokens);

  pendingSignups.splice(idx, 1);
  saveData('pending_signups.json', pendingSignups);

  const link = `https://laowudiy.com/setup?token=${token}`;
  try {
    await mailer.sendMail({
      from: GMAIL_USER,
      to: email,
      subject: 'LaowuDIY - Set Up Your Account',
      html: `<h2>Welcome to LaowuDIY!</h2><p>Your signup request has been approved. Click the link below to create your username and password:</p><p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#ff7a18;color:#000;text-decoration:none;border-radius:8px;font-weight:bold">Set Up Account</a></p><p>Or copy this link: ${link}</p><p>This link expires in 24 hours.</p><p><strong>Important:</strong> We do not store your password. If you forget it, we can only reset it for you — we cannot recover it.</p>`
    });
    res.json({ ok: true, message: `Setup link emailed to ${email}` });
  } catch (e) {
    res.json({ ok: true, message: `Approved but email failed: ${e.message}. Link: ${link}` });
  }
});

// -- REJECT signup (admin) --
app.post('/admin/reject-signup', requireAdmin, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
  const idx = pendingSignups.findIndex(p => p.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  pendingSignups.splice(idx, 1);
  saveData('pending_signups.json', pendingSignups);
  res.json({ ok: true, message: 'Rejected and removed' });
});

// -- GET blocked IPs (owner only) --
app.get('/admin/blocked-ips', requireOwner, (req, res) => {
  const now = Date.now();
  const ips = [];
  for (const [ip, att] of Object.entries(loginAttempts)) {
    if (att.lockedUntil && now < att.lockedUntil) {
      ips.push({ ip, type: 'ip-lock', lockedUntil: att.lockedUntil, phase: att.phase, minsLeft: Math.ceil((att.lockedUntil - now) / 60000) });
    }
  }
  const locked = users.filter(u => u.accountLocked).map(u => ({ ip: u.username, type: 'account-lock', username: u.username }));
  res.json({ ok: true, blocked: [...ips, ...locked] });
});

// -- POST unblock IP (owner only) --
app.post('/admin/unblock-ip', requireOwner, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: 'IP required' });
  if (loginAttempts[ip]) { delete loginAttempts[ip]; return res.json({ ok: true, message: 'IP unlocked' }); }
  const user = users.find(u => u.username === ip && u.accountLocked);
  if (user) { user.accountLocked = false; saveData('users.json', users); return res.json({ ok: true, message: 'Account unlocked' }); }
  res.status(404).json({ ok: false, error: 'Not found' });
});

// -- VALIDATE setup token (public) --
app.get('/setup/validate', (req, res) => {
  const token = req.query.token;
  if (!token || !setupTokens[token])
    return res.json({ ok: false, error: 'Invalid or expired link.' });
  const t = setupTokens[token];
  if (Date.now() > t.expiresAt) {
    delete setupTokens[token];
    saveData('setup_tokens.json', setupTokens);
    return res.json({ ok: false, error: 'Link expired. Contact admin.' });
  }
  res.json({ ok: true, type: t.type, email: t.email, username: t.username || null });
});

// -- SETUP: create account with username+password (public, token required) --
app.post('/setup', async (req, res) => {
  const { token, username, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ ok: false, error: 'Token and password required.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
  if (!/[^A-Za-z0-9]/.test(password)) return res.status(400).json({ ok: false, error: "Password must contain at least 1 special character." });

  const t = setupTokens[token];
  if (!t) return res.status(400).json({ ok: false, error: 'Invalid or expired link.' });
  if (Date.now() > t.expiresAt) {
    delete setupTokens[token]; saveData('setup_tokens.json', setupTokens);
    return res.status(400).json({ ok: false, error: 'Link expired. Contact admin.' });
  }

  if (t.type === 'signup') {
    if (!username || username.length < 2 || username.length > 20)
      return res.status(400).json({ ok: false, error: 'Username must be 2-20 characters.' });
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
      return res.status(400).json({ ok: false, error: 'Username already taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  if (t.type === 'signup') {
    // New account
    users.push({ username, passwordHash, email: t.email, role: 'user', status: 'active', createdAt: Date.now() });
  } else if (t.type === 'reset') {
    // Password reset - update existing user
    const user = users.find(u => u.username === t.username);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
    user.passwordHash = passwordHash;
  }
  saveData('users.json', users);

  // Delete used token
  delete setupTokens[token];
  saveData('setup_tokens.json', setupTokens);

  const msg = t.type === 'reset' ? 'Password reset successfully!' : 'Account created! You can now log in at music.laowudiy.com';
  res.json({ ok: true, message: msg + 'You can now log in.' });
});

// -- ADMIN: Reset password (generates token + emails link) --
app.post('/admin/reset-password/:username', requireAdmin, async (req, res) => {
  const user = users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  if (!user.email) return res.status(400).json({ ok: false, error: 'User has no email' });

  const token = generateSetupToken();
  setupTokens[token] = { email: user.email, username: user.username, type: 'reset', createdAt: Date.now(), expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  saveData('setup_tokens.json', setupTokens);

  const link = `https://laowudiy.com/reset?token=${token}`;
  try {
    await mailer.sendMail({
      from: GMAIL_USER, to: user.email,
      subject: 'LaowuDIY - Reset Your Password',
      html: `<h2>Password Reset</h2><p>Click below to set a new password:</p><p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#ff7a18;color:#000;text-decoration:none;border-radius:8px;font-weight:bold">Reset Password</a></p><p>Or copy: ${link}</p><p>Expires in 12 hours.</p>`
    });
    res.json({ ok: true, message: `Reset link emailed to ${user.email}` });
  } catch (e) {
    res.json({ ok: true, message: `Email failed: ${e.message}. Link: ${link}` });
  }
});

// ─── WEBSOCKET SYNC ──────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Map(); // username -> Set of ws connections
const playStates = new Map(); // username -> { songId, position, playing, queue, ts }

function getWsUser(token) {
  const s = sessions[token];
  return s ? s.username : null;
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token = params.get('token');
  const username = getWsUser(token);
  if (!username) { ws.close(4001, 'Unauthorized'); return; }
  ws.username = username;
  if (!wsClients.has(username)) wsClients.set(username, new Set());
  wsClients.get(username).add(ws);

  // Send current play state to newly connected client
  const state = playStates.get(username);
  if (state) ws.send(JSON.stringify({ type: 'sync', ...state }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'playstate') {
        playStates.set(username, { songId: msg.songId, position: msg.position || 0, playing: !!msg.playing, queueIds: msg.queueIds || [], currentIndex: msg.currentIndex || 0, ts: Date.now() });
        // Broadcast to all OTHER connections for this user
        const clients = wsClients.get(username);
        if (clients) {
          const out = JSON.stringify({ type: 'sync', ...playStates.get(username) });
          for (const c of clients) { if (c !== ws && c.readyState === WebSocket.OPEN) c.send(out); }
        }
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    const clients = wsClients.get(username);
    if (clients) { clients.delete(ws); if (clients.size === 0) wsClients.delete(username); }
  });
});

// ─── BOOT ────────────────────────────────────────────────────────────────────

// ─── SESSION CLEANUP ──────────────────────────────────────────────────────────
function cleanExpiredSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of Object.entries(sessions)) {
    if (s.expiresAt && now > s.expiresAt) { delete sessions[token]; removed++; }
  }
  if (removed) { saveData("sessions.json", sessions); console.log("[l5music-core] Cleaned", removed, "expired sessions"); }
}
cleanExpiredSessions();
setInterval(cleanExpiredSessions, 6 * 60 * 60 * 1000); // every 6 hours
scanLibrary().then(() => {
  server.listen(PORT, () => console.log(`[l5music-core] Running on port ${PORT} — v${VERSION}`));
});
