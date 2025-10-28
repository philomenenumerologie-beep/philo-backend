import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import bcrypt from "bcryptjs";

// -------------------------
// CONFIG
// -------------------------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const FREE_ANON = Number(process.env.FREE_ANON || 10);
const FREE_AFTER_SIGNUP = Number(process.env.FREE_AFTER_SIGNUP || 10);
const PAYMENT_ENABLED = String(process.env.PAYMENT_ENABLED || "false") === "true";

// -------------------------
// DB (SQLite)
// -------------------------
sqlite3.verbose();
const db = new sqlite3.Database("./data.sqlite");

// Promises helpers
const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, function(err){ err?rej(err):res(this); }));
const get = (sql, params=[]) => new Promise((res, rej) => db.get(sql, params, (err,row)=> err?rej(err):res(row)));
const all = (sql, params=[]) => new Promise((res, rej) => db.all(sql, params, (err,rows)=> err?rej(err):res(rows)));

await run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    free_tokens INTEGER NOT NULL DEFAULT 0,
    paid_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// -------------------------
// APP
// -------------------------
const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://philomeneia.com", "https://www.philomeneia.com"],
}));

// mémoire pour les invités
const guestUsage = new Map(); // key: ip, value: used count

// auth facultative via JWT (Authorization: Bearer xxx)
function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, email }
  } catch {
    // token invalide -> on ignore, on reste invité
  }
  next();
}
app.use(optionalAuth);

// -------------------------
// ROUTES UTILES A L’UI
// -------------------------
app.get("/", (_req, res) => res.send("API Philomenia OK"));

app.get("/api/config", (_req, res) => {
  res.json({
    paymentEnabled: PAYMENT_ENABLED,
    freeAnon: FREE_ANON,
    freeAfterSignup: FREE_AFTER_SIGNUP
  });
});

app.get("/api/tokens", async (req, res) => {
  if (req.user?.id) {
    const u = await get("SELECT email, free_tokens, paid_tokens FROM users WHERE id = ?", [req.user.id]);
    if (!u) return res.status(401).json({ error: "invalid_user" });
    const total = Math.max((u.free_tokens||0) + (u.paid_tokens||0), 0);
    return res.json({ mode: "user", email: u.email, free: u.free_tokens, paid: u.paid_tokens, total });
  }
  const used = guestUsage.get(req.ip)?.used || 0;
  const remaining = Math.max(FREE_ANON - used, 0);
  res.json({ mode: "guest", free: remaining, paid: 0, total: remaining });
});

// -------------------------
// AUTH: REGISTER / LOGIN
// -------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_fields" });

    const hash = bcrypt.hashSync(password, 10);
    const r = await run(
      "INSERT INTO users (email, password_hash, free_tokens, paid_tokens) VALUES (?,?,?,?)",
      [email.toLowerCase(), hash, FREE_AFTER_SIGNUP, 0]
    );
    const id = r.lastID;
    const token = jwt.sign({ id, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token });
  } catch (err) {
    if (String(err?.message||"").includes("UNIQUE")) {
      return res.status(409).json({ error: "email_exists" });
    }
    res.status(500).json({ error: "register_failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_fields" });

    const u = await get("SELECT id, email, password_hash FROM users WHERE email = ?", [email.toLowerCase()]);
    if (!u) return res.status(401).json({ error: "invalid_credentials" });

    const ok = bcrypt.compareSync(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token });
  } catch {
    res.status(500).json({ error: "login_failed" });
  }
});

// -------------------------
// CHAT (invite ou connecté)
// -------------------------
app.get("/config", (req, res) => {
  res.json({
    paymentEnabled: process.env.PAYMENT_ENABLED === "true",
    freeAnon: parseInt(process.env.FREE_ANON || "1000", 10),
    freeAfterSignup: parseInt(process.env.FREE_AFTER_SIGNUP || "2000", 10),
  });
});
app.post("/api/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "missing_message" });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "api_key_missing" });
  }

  // 1) Vérifier/consommer 1 token
  if (req.user?.id) {
    // utilisateur connecté: consomme free_tokens en priorité puis paid_tokens
    const u = await get("SELECT id, free_tokens, paid_tokens FROM users WHERE id = ?", [req.user.id]);
    if (!u) return res.status(401).json({ error: "invalid_user" });
    let { free_tokens, paid_tokens } = u;
    if ((free_tokens + paid_tokens) <= 0) return res.status(402).json({ error: "no_tokens_left" });

    if (free_tokens > 0) free_tokens -= 1;
    else paid_tokens -= 1;

    await run("UPDATE users SET free_tokens = ?, paid_tokens = ? WHERE id = ?", [free_tokens, paid_tokens, u.id]);
  } else {
    // invité: consomme sur IP
    const used = guestUsage.get(req.ip)?.used || 0;
    if (used >= FREE_ANON) return res.status(402).json({ error: "no_tokens_left" });
    guestUsage.set(req.ip, { used: used + 1 });
  }

  // 2) Appel OpenAI
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }]
      })
    });
    const data = await r.json();
    if (data?.error) return res.status(502).json({ error: "openai_error", details: data.error });

    const reply = data.choices?.[0]?.message?.content || "Réponse vide";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "request_failed" });
  }
});

// -------------------------
// START
// -------------------------
app.listen(PORT, () => {
  console.log(`Philomenia backend running on port ${PORT}`);
});
