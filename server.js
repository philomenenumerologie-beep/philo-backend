// server.js — GPT-4 Turbo avec vrai décompte + mémoire courte + fallback email
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();

// payloads volumineux (images)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ----- CORS -----
const allowed = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // autoriser requêtes same-origin / curl
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS: " + origin));
  }
}));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STARTING_FREE_TOKENS = Number(process.env.STARTING_FREE_TOKENS || 5000);

// ----- Mémoire en RAM -----
const sessions = new Map(); // userKey -> { turns:[{role,content}], ... }
const balances = new Map(); // userKey -> number
const MAX_TURNS = 12;

// utilitaires
const getUserKey = (req) => {
  // accepte userId OU email (body ou query)
  const b = req.body || {};
  const q = req.query || {};
  return (b.userId || b.email || q.userId || q.email || "anonymous").toString().toLowerCase();
};

function getSession(userKey) {
  if (!sessions.has(userKey)) sessions.set(userKey, { turns: [] });
  return sessions.get(userKey);
}
function pushTurn(userKey, role, content) {
  const s = getSession(userKey);
  s.turns.push({ role, content });
  if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
}
function initBalanceIfNeeded(userKey) {
  if (!balances.has(userKey)) balances.set(userKey, STARTING_FREE_TOKENS);
}
function buildMessages(userKey, text, imageDataUrl) {
  const s = getSession(userKey);
  const msgs = [
    {
      role: "system",
      content:
        "Tu es Philomène IA. Réponds clairement, en français par défaut. " +
        "Utilise le présent pour les connaissances générales et mentionne l'incertitude pour l'actualité récente. " +
        "Si l'utilisateur envoie une image, décris et analyse."
    },
    ...s.turns.map(t => ({ role: t.role, content: t.content }))
  ];

  if (imageDataUrl) {
    msgs.push({
      role: "user",
      content: [
        { type: "text", text: text || "Analyse cette image." },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    });
  } else {
    msgs.push({ role: "user", content: text || "" });
  }
  return msgs;
}

// ----- Health & debug -----
app.get("/", (_req, res) => {
  res.send("✅ Philomène API en ligne (GPT-4 Turbo + décompte)");
});
app.get("/api/ping", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ----- Soldes -----
app.get("/api/balance", (req, res) => {
  const userKey = getUserKey(req);
  initBalanceIfNeeded(userKey);
  res.json({ free: balances.get(userKey) || 0, paid: 0 });
});

// Reset conversation
app.post("/api/clear", (req, res) => {
  const userKey = getUserKey(req);
  sessions.delete(userKey);
  res.json({ ok: true });
});

// ----- Chat -----
app.post("/api/chat", async (req, res) => {
  try {
    const userKey = getUserKey(req);
    const { message, imageDataUrl } = req.body || {};

    if (!message && !imageDataUrl) {
      return res.status(400).json({ error: "message ou image requis" });
    }

    initBalanceIfNeeded(userKey);
    const remaining = balances.get(userKey) || 0;
    if (remaining <= 0) {
      return res.status(402).json({ error: "Solde insuffisant", remaining: 0 });
    }

    // mode test si pas de clé openai
    if (!OPENAI_API_KEY) {
      pushTurn(userKey, "user", message || "(photo)");
      const fake = "Mode test: ajoute OPENAI_API_KEY dans Render > Env Vars.";
      pushTurn(userKey, "assistant", fake);
      return res.json({
        reply: fake,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        remaining
      });
    }

    const messages = buildMessages(userKey, message || "", imageDataUrl);

    // GPT-4 Turbo
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages,
        temperature: 0.4
      })
    });

    const j = await r.json();
    if (!r.ok) {
      console.error("OpenAI error:", j);
      return res.status(500).json({ error: j.error?.message || "OpenAI error" });
    }

    const reply = j?.choices?.[0]?.message?.content?.trim() || "Désolé, pas de réponse.";
    const usage = j?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // maj mémoire + solde
    pushTurn(userKey, "user", message || "(photo)");
    pushTurn(userKey, "assistant", reply);

    const used = Number(usage.total_tokens || 0);
    const newBalance = Math.max(0, (balances.get(userKey) || 0) - used);
    balances.set(userKey, newBalance);

    res.json({ reply, usage, remaining: newBalance });
  } catch (e) {
    console.error("server error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log("✅ API GPT-4 Turbo + décompte de tokens sur port", PORT);
});
