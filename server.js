// server.js — GPT-4 Turbo avec vrai décompte de tokens + mémoire courte
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();

// autoriser gros payloads pour les photos
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// CORS
const allowed = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS: " + origin));
    },
  })
);

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STARTING_FREE_TOKENS = Number(process.env.STARTING_FREE_TOKENS || 5000);

// ———————————————————————————————
// Mémoire & soldes en RAM (clé = userId)
// ———————————————————————————————
const sessions = new Map(); // userId -> { turns: [{role, content}], summary?: string }
const balances = new Map(); // userId -> number (tokens restants)
const MAX_TURNS = 12;

// helpers
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { turns: [] });
  return sessions.get(userId);
}
function pushTurn(userId, role, content) {
  const s = getSession(userId);
  s.turns.push({ role, content });
  if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
}
function initBalanceIfNeeded(userId) {
  if (!balances.has(userId)) balances.set(userId, STARTING_FREE_TOKENS);
}
function buildMessages(userId, text, imageDataUrl) {
  const s = getSession(userId);
  const msgs = [
    {
      role: "system",
      content:
        "Tu es Philomène IA. Réponds clairement, en français par défaut. " +
        "Utilise le présent pour les connaissances générales, mentionne l'incertitude pour l'actualité. " +
        "Si l'utilisateur envoie une image, décris et analyse.",
    },
    ...s.turns.map(t => ({ role: t.role, content: t.content })),
  ];

  if (imageDataUrl) {
    msgs.push({
      role: "user",
      content: [
        { type: "text", text: text || "Analyse cette image." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    });
  } else {
    msgs.push({ role: "user", content: text });
  }
  return msgs;
}

// ———————————————————————————————
// Routes
// ———————————————————————————————
app.get("/", (_, res) =>
  res.send("✅ Philomène API (GPT-4 Turbo, décompte de tokens) en ligne")
);

app.get("/api/balance", (req, res) => {
  const userId = req.query.userId || "anonymous";
  initBalanceIfNeeded(userId);
  res.json({ free: balances.get(userId) || 0, paid: 0 });
});

// Reset conversation (optionnel pour debug)
app.post("/api/clear", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId requis" });
  sessions.delete(userId);
  res.json({ ok: true });
});

// Chat
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message, imageDataUrl } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId requis" });
    if (!message && !imageDataUrl)
      return res.status(400).json({ error: "message ou image requis" });

    initBalanceIfNeeded(userId);
    const remaining = balances.get(userId) || 0;
    if (remaining <= 0) {
      return res.status(402).json({
        error: "Solde insuffisant",
        remaining: 0,
      });
    }

    if (!OPENAI_API_KEY) {
      // mode test sans clé
      pushTurn(userId, "user", message || "(photo)");
      const fake = "Mode test: ajoute ta clé OPENAI_API_KEY sur Render.";
      pushTurn(userId, "assistant", fake);
      return res.json({
        reply: fake,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        remaining: remaining,
      });
    }

    const messages = buildMessages(userId, message || "", imageDataUrl);

    // ⚠️ Modèle GPT-4 Turbo (payant)
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages,
        temperature: 0.4,
      }),
    });

    const j = await r.json();
    if (!r.ok) {
      console.error(j);
      return res.status(500).json({ error: j.error?.message || "OpenAI error" });
    }

    const reply = j?.choices?.[0]?.message?.content?.trim() || "Désolé, pas de réponse.";
    const usage = j?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // maj mémoire
    pushTurn(userId, "user", message || "(photo)");
    pushTurn(userId, "assistant", reply);

    // décompte vrai tokens OpenAI
    const used = Number(usage.total_tokens || 0);
    let newBalance = Math.max(0, remaining - used);
    balances.set(userId, newBalance);

    res.json({
      reply,
      usage,
      remaining: newBalance,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log("✅ API GPT-4 Turbo avec décompte de tokens sur port", PORT);
});
