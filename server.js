// server.js — mémoire de conversation en RAM (simple et efficace)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS autorisés (mets tes domaines)
const allowed = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      console.log("❌ CORS:", origin);
      cb(new Error("Not allowed by CORS"));
    },
  })
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 10000;

// ———————————————————————————————
// MÉMOIRE EN RAM (par utilisateur)
// ———————————————————————————————
/*
  sessions: Map<userId, {
    summary: string | null,    // pour plus tard (résumé long)
    turns: Array<{role:"user"|"assistant", content:string}> // derniers échanges
  }>
*/
const sessions = new Map();
const MAX_TURNS = 12; // on garde les 12 derniers messages (6 allers-retours)

/** Récupère ou crée la session d’un user */
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { summary: null, turns: [] });
  }
  return sessions.get(userId);
}

/** Ajoute un tour et coupe si trop long */
function pushTurn(userId, role, content) {
  const s = getSession(userId);
  s.turns.push({ role, content });
  // on limite la longueur
  if (s.turns.length > MAX_TURNS) {
    s.turns.splice(0, s.turns.length - MAX_TURNS);
  }
}

/** Construit le contexte envoyé au modèle */
function buildMessages(userId, userText, imageDataUrl) {
  const s = getSession(userId);
  const system = {
    role: "system",
    content:
      "Tu es Philomène IA. Réponds clairement, au présent quand c’est du contexte général, " +
      "et fais le lien avec le passé si c’est utile. Si tu n'es pas sûr pour l’actualité, " +
      "dis-le et propose de vérifier. Langue par défaut: français. Date: " +
      new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
  };

  const msgs = [system];

  if (s.summary) {
    msgs.push({
      role: "system",
      content: "Mémoire condensée de la conversation: " + s.summary,
    });
  }

  // on insère l’historique court
  for (const t of s.turns) {
    msgs.push({ role: t.role, content: t.content });
  }

  // on ajoute le message en cours (texte + éventuellement image)
  if (imageDataUrl) {
    msgs.push({
      role: "user",
      content: [
        { type: "text", text: userText || "Analyse cette image." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    });
  } else {
    msgs.push({ role: "user", content: userText });
  }

  return msgs;
}

// ———————————————————————————————
// ROUTES
// ———————————————————————————————
app.get("/", (_, res) => res.send("✅ Philomène API en ligne (mémoire RAM)"));

app.get("/api/balance", (_, res) => res.json({ free: 5000, paid: 0 }));

// Effacer la mémoire d’un user (debug facultatif)
app.post("/api/clear", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId requis" });
  sessions.delete(userId);
  res.json({ ok: true });
});

// Chat principal (texte + image, avec mémoire)
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message, imageDataUrl } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId requis" });
    if (!message && !imageDataUrl) return res.status(400).json({ error: "message ou image requis" });

    // Si pas de clé, on simule juste la mémoire pour test
    if (!OPENAI_API_KEY) {
      pushTurn(userId, "user", message || "(photo)");
      const fake = "Mode test: pas de clé OpenAI configurée.";
      pushTurn(userId, "assistant", fake);
      return res.json({ reply: fake, charged: false, mode: imageDataUrl ? "vision" : "chat" });
    }

    // construit contexte selon l’historique
    const messages = buildMessages(userId, message || "", imageDataUrl);

    // appel modèle
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini", // texte + vision
        messages,
        temperature: 0.4,
      }),
    });

    const j = await r.json();
    const reply = j?.choices?.[0]?.message?.content || "Désolé, pas de réponse.";

    // on stocke tour user + tour assistant
    pushTurn(userId, "user", message || "(photo)");
    pushTurn(userId, "assistant", reply);

    res.json({ reply, charged: true, mode: imageDataUrl ? "vision" : "chat" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Lancement
app.listen(PORT, () => {
  console.log("✅ API avec mémoire sur port", PORT);
});
