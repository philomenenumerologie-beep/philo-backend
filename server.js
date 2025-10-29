// server.js — Philomène IA (backend complet)
// CORS robuste • Solde tokens • Chat texte+photo (vision) • Offres tokens (simu PayPal)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();
app.use(express.json({ limit: "25mb" }));

// ===== CORS
const rawAllow = process.env.ALLOW_ORIGINS || "";
const allowedHosts = rawAllow
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(u => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } })
  .filter(Boolean);
const stripWww = h => h.replace(/^www\./, "");
const hostFromOrigin = o => { try { return new URL(o).hostname.toLowerCase(); } catch { return ""; } };

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const h = hostFromOrigin(origin);
    const ok = allowedHosts.includes(h) || allowedHosts.map(stripWww).includes(stripWww(h));
    if (ok) return cb(null, true);
    console.log("❌ CORS blocked:", origin, "allowed:", allowedHosts);
    cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.options("*", cors());

// ===== “DB” en mémoire
const DEFAULT_FREE = Number(process.env.FREE_AFTER_SIGNUP || 5000);
const DEFAULT_ANON = Number(process.env.FREE_ANON || 0);

// email -> { free, paid, greeted }
const users = new Map();
const getUser = (email) => {
  const key = (email || "").toLowerCase().trim();
  if (!users.has(key)) users.set(key, { free: key ? DEFAULT_FREE : DEFAULT_ANON, paid: 0, greeted: false });
  return users.get(key);
};
const total = (u) => (u.free || 0) + (u.paid || 0);
const consume = (u, n) => {
  let rest = n;
  if (u.paid >= rest) { u.paid -= rest; rest = 0; }
  else { rest -= u.paid; u.paid = 0; if (u.free >= rest) { u.free -= rest; rest = 0; } }
  return rest === 0;
};

// ===== OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || "gpt-4o-mini";

async function callOpenAI({ systemPrompt, userText, images = [] }) {
  const content = [];
  if (userText?.trim()) content.push({ type: "text", text: userText.trim() });
  for (const dataUrl of images) content.push({ type: "image_url", image_url: { url: dataUrl } });

  if (!OPENAI_API_KEY) {
    const fake = images.length ? "J’ai bien reçu ta photo. (Mode test sans clé OpenAI)"
                               : "Réponse de test (pas de clé OpenAI configurée).";
    return { reply: fake, tokensUsed: 50 };
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system",
          content: systemPrompt
        },
        { role: "user",
          content: content.length ? content : [{ type: "text", text: userText || "" }]
        }
      ]
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "Je n’ai rien reçu, réessaie.";
  const used = data?.usage?.total_tokens ??
               ((data?.usage?.prompt_tokens || 0) + (data?.usage?.completion_tokens || 0)) ||
               120;
  return { reply, tokensUsed: used };
}

// ===== Routes
app.get("/", (_req, res) => res.send("✅ API en ligne"));

app.get("/api/balance", (req, res) => {
  const email = String(req.query.email || "");
  const u = getUser(email);
  res.json({ free: u.free, paid: u.paid });
});

// Recharge “offre” (simu PayPal) : ajoute des tokens payants
// body: { email, amount }  amount > 0
app.post("/api/topup_custom", (req, res) => {
  const { email, amount } = req.body || {};
  const amt = Number(amount || 0);
  if (!email || !amt || amt <= 0) return res.status(400).json({ error: "Paramètres invalides" });
  const u = getUser(email);
  u.paid += amt;
  return res.json({ ok: true, free: u.free, paid: u.paid, added: amt });
});

// Petit topup “bonus”
app.post("/api/topup", (req, res) => {
  const { email } = req.body || {};
  const u = getUser(email || "");
  const bonus = Number(process.env.TOPUP_AMOUNT || 1000);
  u.free += bonus;
  res.json({ ok: true, free: u.free, paid: u.paid, added: bonus });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, email, first, images } = req.body || {};
    if ((!message || !message.trim()) && (!images || !images.length)) {
      return res.status(400).json({ error: "Message ou image requis" });
    }
    const u = getUser(email || "");

    // Style présent + prudence actu
    const systemPrompt = `
Tu es Philomène IA, assistant personnel polyvalent, clair et chaleureux. Langue de l’utilisateur.
Parle **au présent**. Quand l’information est sujette à changement (actualité, sport, gouvernement, prix, météo),
formule au présent **avec prudence** et transparence: 
- "À ma dernière mise à jour de connaissances, c’était … ; cela peut avoir changé récemment."
- Propose si utile de vérifier sur une source récente.
Donne des réponses concrètes et actionnables.`;

    let userText = message || "";
    if (first && u.greeted !== true) {
      userText = "Bonjour 👋 Je suis Philomène IA, ton assistante perso. " +
                 "Pose ta question ou envoie une photo, je m’occupe du reste.\n\n" +
                 (message || "");
      u.greeted = true;
    }

    const { reply, tokensUsed } = await callOpenAI({
      systemPrompt,
      userText,
      images: Array.isArray(images) ? images : []
    });

    if (total(u) < tokensUsed) {
      return res.status(402).json({ error: "Crédits insuffisants", needed: tokensUsed, free: u.free, paid: u.paid });
    }
    consume(u, tokensUsed);

    res.json({ reply, tokensUsed, balance: { free: u.free, paid: u.paid } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Route non trouvée" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Backend Philomène IA en ligne sur port", PORT);
  console.log("ALLOW_ORIGINS =", rawAllow);
});
