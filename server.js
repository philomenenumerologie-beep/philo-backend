// server.js — Auth + Tokens (anonyme 1000 → 2000 après inscription)
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { randomUUID } = require('crypto');

// ====== Config ======
const PORT = process.env.PORT || 10000;
const FREE_ANON = parseInt(process.env.FREE_ANON || '1000', 10);
const FREE_AFTER_SIGNUP = parseInt(process.env.FREE_AFTER_SIGNUP || '2000', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ===== App/CORS =====
const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));
app.set('trust proxy', 1);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // autorise app mobile, Postman, etc.
    if (!ALLOW_ORIGINS || ALLOW_ORIGINS.length === 0) return cb(null, true);
    return cb(null, ALLOW_ORIGINS.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // préflight
// --- Health check & debug ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), origin: req.headers.origin || null });
});
// ===== fin CORS =====

// ====== DB ======
const db = new sqlite3.Database('data.sqlite');
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      freeRemaining INTEGER DEFAULT 0,
      paidBalance INTEGER DEFAULT 0,
      isAnonymous INTEGER DEFAULT 1,
      createdAt INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT,
      createdAt INTEGER
    )
  `);
});

// ====== Helpers ======
function now() { return Date.now(); }

function setCookie(res, name, value, days = 365) {
  const ms = days * 24 * 60 * 60 * 1000;
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    signed: name === 'philo_sess',
    maxAge: ms
  });
}

function clearCookie(res, name) {
  res.clearCookie(name, {
    httpOnly: true,
    sameSite: 'none',
    secure: true
  });
}

function createSession(res, userId) {
  const token = randomUUID();
  db.run(`INSERT INTO sessions(id,userId,createdAt) VALUES(?,?,?)`,
    [token, userId, now()],
    (err) => {
      if (!err) setCookie(res, 'philo_sess', token);
    });
}

function auth(req, res, next) {
  const token = req.signedCookies?.philo_sess;
  if (!token) return res.status(401).json({ error: 'not_logged_in' });
  db.get(`SELECT userId FROM sessions WHERE id=?`, [token], (e, row) => {
    if (e || !row) return res.status(401).json({ error: 'not_logged_in' });
    db.get(`SELECT * FROM users WHERE id=?`, [row.userId], (e2, u) => {
      if (e2 || !u) return res.status(401).json({ error: 'not_logged_in' });
      req.user = u;
      next();
    });
  });
}

// ====== 0) Start (crée anonyme si pas de cookie) ======
app.post('/api/start', (req, res) => {
  const anonCookie = req.cookies?.philo_anon;
  if (anonCookie) {
    // Vérifie que l'utilisateur existe
    db.get(`SELECT * FROM users WHERE id=?`, [anonCookie], (e, u) => {
      if (!e && u) {
        return res.json({
          ok: true,
          user: {
            id: u.id,
            isAnonymous: !!u.isAnonymous,
            freeRemaining: u.freeRemaining || 0,
            paidBalance: u.paidBalance || 0
          }
        });
      }
      return createAnon();
    });
  } else {
    return createAnon();
  }

  function createAnon() {
    const id = 'anon-' + randomUUID();
    db.run(
      `INSERT INTO users(id,freeRemaining,paidBalance,isAnonymous,createdAt) VALUES (?,?,?,?,?)`,
      [id, FREE_ANON, 0, 1, now()],
      (err) => {
        if (err) return res.status(500).json({ error: 'db_error', detail: err.message });
        setCookie(res, 'philo_anon', id);
        return res.json({
          ok: true,
          user: { id, isAnonymous: true, freeRemaining: FREE_ANON, paidBalance: 0 }
        });
      }
    );
  }
});

// ====== 1) Login ======
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });

    db.get(`SELECT * FROM users WHERE email=? AND isAnonymous=0`, [email], async (e, u) => {
      if (e || !u) return res.status(400).json({ error: 'invalid_credentials' });
      const ok = await bcrypt.compare(password, u.password_hash || '');
      if (!ok) return res.status(400).json({ error: 'invalid_credentials' });
      createSession(res, u.id);
      clearCookie(res, 'philo_anon');
      res.json({
        ok: true,
        freeRemaining: u.freeRemaining || 0,
        paidBalance: u.paidBalance || 0
      });
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

// ====== 2) Signup (upgrade anonyme → compte réel + 2000) ======
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const passHash = await bcrypt.hash(password, 10);
    const anonId = req.cookies?.philo_anon;

    if (anonId) {
      // Upgrade l'utilisateur anonyme s'il existe et est encore anonyme
      db.get(`SELECT id FROM users WHERE id=? AND isAnonymous=1`, [anonId], (e, row) => {
        if (e) return res.status(500).json({ error: 'db_error', detail: e.message });
        if (row) {
          db.run(
            `UPDATE users SET email=?, password_hash=?, freeRemaining=?, isAnonymous=0 WHERE id=?`,
            [email, passHash, FREE_AFTER_SIGNUP, anonId],
            (err) => {
              if (err) {
                if (String(err.message).includes('UNIQUE')) {
                  return res.status(400).json({ error: 'email_taken' });
                }
                return res.status(500).json({ error: 'db_error', detail: err.message });
              }
              clearCookie(res, 'philo_anon');
              createSession(res, anonId);
              return res.json({ ok: true, user: { id: anonId } });
            }
          );
        } else {
          // cookie invalide → crée un nouveau compte
          return createNewUser(email, passHash, res);
        }
      });
    } else {
      // pas de cookie anonyme → nouveau user
      return createNewUser(email, passHash, res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }

  function createNewUser(email, passHash, resLocal) {
    const id = randomUUID();
    db.run(
      `INSERT INTO users(id,email,password_hash,freeRemaining,paidBalance,isAnonymous,createdAt) VALUES (?,?,?,?,?,?,?)`,
      [id, email, passHash, FREE_AFTER_SIGNUP, 0, 0, now()],
      (err) => {
        if (err) {
          if (String(err.message).includes('UNIQUE')) {
            return resLocal.status(400).json({ error: 'email_taken' });
          }
          return resLocal.status(500).json({ error: 'db_error', detail: err.message });
        }
        createSession(resLocal, id);
        return resLocal.json({ ok: true, user: { id } });
      }
    );
  }
});

// ====== 3) Me (solde) ======
app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    email: u.email,
    isAnonymous: !!u.isAnonymous,
    freeRemaining: u.freeRemaining || 0,
    paidBalance: u.paidBalance || 0,
    totalRemaining: (u.freeRemaining || 0) + (u.paidBalance || 0)
  });
});

// ====== 4) Dépenser des tokens ======
app.post('/api/use', auth, (req, res) => {
  const cost = parseInt((req.body && req.body.cost) || '0', 10);
  if (isNaN(cost) || cost <= 0) return res.status(400).json({ error: 'bad_cost' });
  const uid = req.user.id;

  db.get(`SELECT freeRemaining, paidBalance FROM users WHERE id=?`, [uid], (e, row) => {
    if (e || !row) return res.status(500).json({ error: 'db_error' });

    let free = row.freeRemaining || 0;
    let paid = row.paidBalance || 0;
    if (free + paid < cost) return res.status(400).json({ error: 'not_enough_tokens' });

    if (free >= cost) {
      free -= cost;
    } else {
      const left = cost - free;
      free = 0;
      paid = Math.max(0, paid - left);
    }

    db.run(
      `UPDATE users SET freeRemaining=?, paidBalance=? WHERE id=?`,
      [free, paid, uid],
      (err) => {
        if (err) return res.status(500).json({ error: 'db_error' });
        res.json({ ok: true, freeRemaining: free, paidBalance: paid, totalRemaining: free + paid });
      }
    );
  });
});

// ====== 5) Logout ======
app.post('/api/logout', auth, (req, res) => {
  const token = req.signedCookies.philo_sess;
  db.run(`DELETE FROM sessions WHERE id=?`, [token], () => {
    clearCookie(res, 'philo_sess');
    res.json({ ok: true });
  });
});

// ====== Start server ======
app.listen(PORT, () => console.log(`✅ Auth/Tokens server running on ${PORT}`));
