// server.js — Étape 1 : comptes + 1000 (anonyme) → 2000 (après inscription)
// CommonJS / Express / SQLite / Cookies / CORS

require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;
const FREE_ANON = parseInt(process.env.FREE_ANON || '1000', 10);
const FREE_AFTER_SIGNUP = parseInt(process.env.FREE_AFTER_SIGNUP || '2000', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

// --- CORS
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb){
    if (!origin) return cb(null, true);
    if (ORIGINS.length === 0 || ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// --- SQLite (persistant dans ./philo.db)
const db = new sqlite3.Database('./philo.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    freeRemaining INTEGER,
    paidBalance INTEGER DEFAULT 0,
    isAnonymous INTEGER DEFAULT 1,
    createdAt INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT,
    createdAt INTEGER
  )`);
});

// --- Utils
const now = () => Date.now();
const setCookie = (res, name, value) => {
  res.cookie(name, value, {
    maxAge: 30*24*3600*1000, // 30 jours
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PROD
  });
};
const clearCookie = (res, name) => res.clearCookie(name, { httpOnly: true, sameSite: 'Lax', secure: IS_PROD });

function createSession(res, userId){
  const token = uuidv4();
  db.run(`INSERT INTO sessions(token,userId,createdAt) VALUES(?,?,?)`, [token, userId, now()]);
  setCookie(res, 'philo_sess', token);
}

function auth(req, res, next){
  const token = req.cookies.philo_sess;
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  db.get(`SELECT userId FROM sessions WHERE token = ?`, [token], (e, row) => {
    if (e || !row) return res.status(401).json({ error: 'not_authenticated' });
    db.get(`SELECT id,email,freeRemaining,paidBalance,isAnonymous FROM users WHERE id = ?`, [row.userId], (e2,u) => {
      if (e2 || !u) return res.status(401).json({ error: 'not_authenticated' });
      req.user = u; next();
    });
  });
}

// --------- ROUTES ---------

// Health
app.get('/', (_req,res)=>res.json({ ok:true }));
app.get('/health', (_req,res)=>res.json({ ok:true }));

// 1) Session anonyme -> 1000 tokens une seule fois
app.get('/api/anon', (req, res) => {
  const anonId = req.cookies.philo_anon;
  if (anonId) {
    db.get(`SELECT id,freeRemaining,paidBalance,isAnonymous FROM users WHERE id=?`, [anonId], (e,u)=>{
      if (!e && u) {
        return res.json({ ok:true, user:{ id:u.id, freeRemaining:u.freeRemaining, paidBalance:u.paidBalance, isAnonymous: !!u.isAnonymous }});
      }
      // cookie invalide -> recreate
      clearCookie(res, 'philo_anon'); return createAnon();
    });
  } else {
    return createAnon();
  }

  function createAnon(){
    const id = 'anon-' + uuidv4();
    db.run(`INSERT INTO users(id,freeRemaining,paidBalance,isAnonymous,createdAt) VALUES (?,?,?,?,?)`,
      [id, FREE_ANON, 0, 1, now()],
      function(err){
        if (err) return res.status(500).json({ error:'db_error', detail:err.message });
        setCookie(res, 'philo_anon', id);
        return res.json({ ok:true, user:{ id, freeRemaining: FREE_ANON, paidBalance:0, isAnonymous:true }});
      });
  }
});

// 2) Signup (upgrade anonyme -> compte réel + 2000 tokens)
//    Si cookie anon présent et encore isAnonymous=1 : on UPGRADE CETTE LIGNE
//    Sinon : on crée un nouveau user avec 2000
app.post('/api/signup', async (req, res) => {
  try{
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error:'missing_fields' });
    const passHash = await bcrypt.hash(password, 10);
    const anonId = req.cookies.philo_anon;

    if (anonId) {
      db.get(`SELECT id FROM users WHERE id=? AND isAnonymous=1`, [anonId], (e,row)=>{
        if (e) return res.status(500).json({ error:'db_error', detail:e.message });
        if (row) {
          // upgrade
          db.run(`UPDATE users SET email=?, password_hash=?, freeRemaining=?, isAnonymous=0 WHERE id=?`,
            [email, passHash, FREE_AFTER_SIGNUP, anonId],
            function(err){
              if (err) {
                if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error:'email_exists' });
                return res.status(500).json({ error:'db_error', detail:err.message });
              }
              clearCookie(res, 'philo_anon');
              createSession(res, anonId);
              return res.json({ ok:true, user:{ id: anonId, email, freeRemaining: FREE_AFTER_SIGNUP, paidBalance:0, isAnonymous:false }});
            });
        } else {
          // pas d'anon valide -> nouveau compte
          return createNewUser(email, passHash, res);
        }
      });
    } else {
      // pas de cookie anon -> nouveau compte
      return createNewUser(email, passHash, res);
    }
  }catch(err){
    return res.status(500).json({ error:'server_error', detail: err.message });
  }

  function createNewUser(email, passHash, resLocal){
    const id = uuidv4();
    db.run(`INSERT INTO users(id,email,password_hash,freeRemaining,paidBalance,isAnonymous,createdAt) VALUES(?,?,?,?,?,?,?)`,
      [id, email, passHash, FREE_AFTER_SIGNUP, 0, 0, now()],
      function(err){
        if (err) {
          if (String(err.message).includes('UNIQUE')) return resLocal.status(400).json({ error:'email_exists' });
          return resLocal.status(500).json({ error:'db_error', detail:err.message });
        }
        createSession(resLocal, id);
        return resLocal.json({ ok:true, user:{ id, email, freeRemaining: FREE_AFTER_SIGNUP, paidBalance:0, isAnonymous:false }});
      });
  }
});

// 3) Login
app.post('/api/login', (req,res)=>{
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error:'missing_fields' });
  db.get(`SELECT id,password_hash,freeRemaining,paidBalance FROM users WHERE email=?`, [email], async (e,u)=>{
    if (e || !u) return res.status(400).json({ error:'invalid_credentials' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(400).json({ error:'invalid_credentials' });
    createSession(res, u.id);
    clearCookie(res, 'philo_anon');
    res.json({ ok:true, freeRemaining: u.freeRemaining, paidBalance: u.paidBalance });
  });
});

// 4) Me (solde)
app.get('/api/me', auth, (req,res)=>{
  const u = req.user;
  res.json({
    id: u.id,
    email: u.email,
    isAnonymous: !!u.isAnonymous,
    freeRemaining: u.freeRemaining||0,
    paidBalance: u.paidBalance||0,
    totalRemaining: (u.freeRemaining||0) + (u.paidBalance||0)
  });
});

// 5) Dépenser des tokens (ex.: envoyer un message)
// body: { cost: number }
app.post('/api/use', auth, (req,res)=>{
  const cost = parseInt((req.body && req.body.cost) || 1, 10);
  if (isNaN(cost) || cost <= 0) return res.status(400).json({ error:'invalid_cost' });
  const uid = req.user.id;
  db.get(`SELECT freeRemaining,paidBalance FROM users WHERE id=?`, [uid], (e,row)=>{
    if (e || !row) return res.status(500).json({ error:'db_error' });
    let free = row.freeRemaining||0, paid = row.paidBalance||0;
    if (free + paid < cost) return res.status(400).json({ error:'not_enough_tokens' });
    if (free >= cost) free -= cost;
    else { const left = cost - free; free = 0; paid = Math.max(0, paid - left); }
    db.run(`UPDATE users SET freeRemaining=?, paidBalance=? WHERE id=?`, [free, paid, uid], (err)=>{
      if (err) return res.status(500).json({ error:'db_error' });
      res.json({ ok:true, freeRemaining:free, paidBalance:paid, totalRemaining: free+paid });
    });
  });
});

// 6) Logout
app.post('/api/logout', auth, (req,res)=>{
  const token = req.cookies.philo_sess;
  db.run(`DELETE FROM sessions WHERE token=?`, [token], ()=>{
    clearCookie(res, 'philo_sess');
    res.json({ ok:true });
  });
});

app.listen(PORT, ()=>console.log('✅ Auth/Tokens server running on', PORT));
