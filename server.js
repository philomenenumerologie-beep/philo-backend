import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();

// ———————————— Middleware ————————————
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const allowed = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS: " + origin));
  }
}));

// ———————————— Variables ————————————
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STARTING_FREE_TOKENS = Number(process.env.STARTING_FREE_TOKENS || 5000);

// ———————————— Mémoire ————————————
const sessions = new Map();
const balances = new Map();
const MAX_TURNS = 12;

// Helpers
function getUserKey(req) {
  const b = req.body || {};
  const q = req.query || {};
  return (b.userId || b.email || q.userId || q.email || "anonymous").toString().toLowerCase();
}

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
        "Tu es Philomène IA. Réponds en français, clairement. " +
        "Utilise le présent pour les connaissances générales, et précise l’incertitude pour l’actualité récente. " +
        "Si une image est envoyée, analyse-la."
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

// ———————————— Routes ————————————
app.get("/", (_, res) => res.send("✅ Philomène API GPT-4 Turbo en ligne"));
app.get("/api/ping", (_, res) => res.json({ ok: true, time: Date.now() }));

app.get("/api/balance", (req, res) => {
  const userKey = getUserKey(req);
  initBalanceIfNeeded(userKey);
  res.json({ free: balances.get(userKey) || 0, paid: 0 });
});

app.post("/api/clear", (req, res) => {
  const userKey = getUserKey(req);
  sessions.delete(userKey);
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  try {
    const userKey = getUserKey(req);
    const { message, imageDataUrl } = req.body || {};

    if (!message && !imageDataUrl)
      return res.status(400).json({ error: "message ou image requis" });

    initBalanceIfNeeded(userKey);
    const remaining = balances.get(userKey);
    if (remaining <= 0)
      return res.status(402).json({ error: "Solde insuffisant", remaining: 0 });

    if (!OPENAI_API_KEY) {
      const fake = "Mode test : ajoute ta clé OPENAI_API_KEY dans Render.";
      pushTurn(userKey, "assistant", fake);
      return res.json({ reply: fake, usage: {}, remaining });
    }

    const messages = buildMessages(userKey, message, imageDataUrl);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-4-turbo", messages, temperature: 0.4 })
    });

    const j = await r.json();
    if (!r.ok) {
      console.error(j);
      return res.status(500).json({ error: j.error?.message || "OpenAI error" });
    }

    const reply = j.choices?.[0]?.message?.content?.trim() || "Désolé, pas de réponse.";
    const usage = j.usage || {};
    const used = Number(usage.total_tokens || 0);
    const newBalance = Math.max(0, remaining - used);

    pushTurn(userKey, "user", message || "(photo)");
    pushTurn(userKey, "assistant", reply);
    balances.set(userKey, newBalance);

    res.json({ reply, usage, remaining: newBalance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => console.log("✅ API en ligne sur port", PORT));
