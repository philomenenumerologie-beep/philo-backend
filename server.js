// --- Philomenia backend complet (ESM) ---
// Auth par lien magique (email), SQLite, cookies, CORS, /config, /me, /api/chat

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";

import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import dotenv from "dotenv";
dotenv.config(); // no-op sur Render, utile en local

// ---- chemins utilitaires
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- app
const app = express();
app.use(express.json());
app.use(cookieParser());

// ---- CORS (avec cookies)
function readOrigins() {
  try {
    // Exemple env: ["https://philomeneia.com","https://www.philomeneia.com"]
    return JSON.parse(process.env.ALLOW_ORIGINS || "[]");
  } catch {
    return [];
  }
}
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = readOrigins();
      if (!origin) return cb(null, true); // outils CLI
      if (allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  })
);

// ---- config lecture env
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // par défaut: GPT-4o (rapide et cost-effective)
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL || "https://api.philomeneia.com";
const EMAIL_FROM =
  process.env.EMAIL_FROM || "Philomenia <no-reply@philomeneia.com>";
const MAGIC_TTL_MIN = parseInt(process.env.MAGIC_TOKEN_TTL_MIN || "15", 10);

const PAYMENT_ENABLED = String(process.env.PAYMENT_ENABLED || "false") === "true";
const FREE_ANON = parseInt(process.env.FREE_ANON || "1000", 10);
const FREE_AFTER_SIGNUP = parseInt(process.env.FREE_AFTER_SIGNUP || "2000", 10);

// ---- DB setup
const db = await open({
  filename: path.join(__dirname, "data.db"),
  driver: sqlite3.Database
});

await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  free_tokens INTEGER DEFAULT 0,
  paid_tokens INTEGER DEFAULT 0
);
`);

await db.exec(`
CREATE TABLE IF NOT EXISTS magic_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0
);
`);

// ---- Email (Resend)
const resend = new Resend(process.env.RESEND_API_KEY || "");

// ---- routes de base
app.get("/", (_req, res) => {
  res.send("API Philomenia OK");
});

// Petit fichier de test statique si besoin (optionnel)
// Place un "test.html" à côté du serveur pour voir quelque chose.
// app.get("/test", (_req, res) => {
//   res.sendFile(path.join(__dirname, "test.html"));
// });

// ---- /config pour le front
app.get("/config", (_req, res) => {
  res.json({
    paymentEnabled: PAYMENT_ENABLED,
    freeAnon: FREE_ANON,
    freeAfterSignup: FREE_AFTER_SIGNUP
  });
});

// ---- Utilitaires session
function guestState() {
  const total = FREE_ANON;
  return { mode: "guest", free: FREE_ANON, paid: 0, total };
}

function setSessionCookie(res, jwtToken) {
  res.cookie("session", jwtToken, {
    httpOnly: true,
    secure: true,
    sameSite: "none", // front sur autre domaine
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

// ---- /me : état utilisateur (guest ou connecté)
app.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.session;
    if (!token) return res.json(guestState());

    let data;
    try {
      data = jwt.verify(token, SESSION_SECRET);
    } catch {
      return res.json(guestState());
    }

    const user = await db.get(`SELECT * FROM users WHERE id = ?`, [data.id]);
    if (!user) return res.json(guestState());

    const free = user.free_tokens || 0;
    const paid = user.paid_tokens || 0;
    const total = free + paid;
    return res.json({
      mode: "user",
      email: user.email,
      free,
      paid,
      total
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---- Auth: démarrage (envoi lien magique)
app.post("/auth/start", async (req, res) => {
  try {
    const { email } = req.body || {};
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
    if (!isEmail) return res.status(400).json({ error: "email_invalid" });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + MAGIC_TTL_MIN * 60 * 1000).toISOString();

    await db.run(
      `INSERT INTO magic_tokens (token, email, expires_at, used) VALUES (?, ?, ?, 0)`,
      [token, email, expiresAt]
    );

    const verifyUrl = `${PUBLIC_API_URL}/auth/verify?token=${token}`;

    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: "Ton lien de connexion Philomenia",
      text: `Clique pour te connecter: ${verifyUrl}\nCe lien expire dans ${MAGIC_TTL_MIN} minutes.`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---- Auth: vérification du lien
app.get("/auth/verify", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("missing_token");

    const row = await db.get(`SELECT * FROM magic_tokens WHERE token = ?`, [token]);
    if (!row) return res.status(400).send("token_invalid");
    if (row.used) return res.status(400).send("token_used");
    if (new Date(row.expires_at).getTime() < Date.now())
      return res.status(400).send("token_expired");

    // upsert user
    const email = row.email;
    let user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) {
      await db.run(
        `INSERT INTO users (email, free_tokens, paid_tokens) VALUES (?, ?, ?)`,
        [email, FREE_AFTER_SIGNUP, 0]
      );
      user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
    }

    await db.run(`UPDATE magic_tokens SET used = 1 WHERE token = ?`, [token]);

    const jwtToken = jwt.sign({ id: user.id, email: user.email }, SESSION_SECRET, {
      expiresIn: "7d"
    });
    setSessionCookie(res, jwtToken);

    // redirige vers l'appli
    res.redirect("https://philomeneia.com/?login=success");
  } catch (e) {
    console.error(e);
    res.status(500).send("server_error");
  }
});

// ---- Chat completions (OpenAI)
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "missing_message" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_openai_key" });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL, // ex: "gpt-4o" (par défaut), ou mets OPENAI_MODEL dans l'env
        messages: [{ role: "user", content: message }],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      return res.status(500).json({ error: "openai_error", detail: err });
    }

    const data = await response.json();
    const text =
      data?.choices?.[0]?.message?.content?.trim?.() || "(réponse vide)";
    res.json({ reply: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---- Port / démarrage
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Philomenia backend is running on port ${PORT}`);
});
