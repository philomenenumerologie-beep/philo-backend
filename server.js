// server.js — Philomène IA (backend complet)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch"; // utile si Node < 22
dotenv.config();

const app = express();
app.use(express.json());

// ===== CORS robuste (gère espaces, www., et erreurs de frappe) =====
const rawAllow = process.env.ALLOW_ORIGINS || "";
const allowedHosts = rawAllow
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(u => {
    try { return new URL(u).hostname.toLowerCase(); }
    catch { return null; }
  })
  .filter(Boolean);

const stripWww = h => h.replace(/^www\./, "");
const hostFromOrigin = o => {
  try { return new URL(o).hostname.toLowerCase(); }
  catch { return ""; }
};

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // tests serveur→serveur
    const h = hostFromOrigin(origin);
    const ok = allowedHosts.includes(h) ||
               allowedHosts.map(stripWww).includes(stripWww(h));
    if (ok) return cb(null, true);
    console.log("❌ CORS blocked:", origin, "allowed:", allowedHosts);
    cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.options("*", cors());

// ===== "Base" en mémoire (simple pour la bêta) =====
const DEFAULT_FREE = Number(process.env.FREE_AFTER_SIGNUP || 2500);
const DEFAULT_ANON = Number(process.env.FREE_ANON || 0);
// Map email -> { free, paid, greeted }
const users = new Map();

function getUser(email) {
  const key = (email || "").toLowerCase().trim();
  if (!users.has(key)) {
    users.set(key, { free: key ? DEFAULT_FREE : DEFAULT_ANON, paid: 0, greeted: false });
  }
  return users.get(key);
}
function totalBalance(u) { return (u.free || 0) + (u.paid || 0); }
function consume(u, n) {
  let rest = n;
  if (u.paid >= rest) { u.paid -= rest; rest = 0; }
  else {
    rest -= u.paid; u.paid = 0;
    if (u.free >= rest) { u.free -= rest; rest = 0; }
  }
  return rest === 0;
}

// ===== Helpers OpenAI =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    // Mode dégradé si pas de clé: réponse fixe
    return {
      reply: "Réponse de test (aucune clé OpenAI configurée).",
      tokensUsed: 50
    };
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages
    })
  });

  if (!r.ok) {
    const txt = await r.text();
    console.error("OpenAI error:", txt);
    throw new Error("Erreur OpenAI");
  }

  const data = await r.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "Je n’ai rien reçu, réessaie.";
  const used = data?.usage?.total_tokens ?? (
    (data?.usage?.prompt_tokens || 0) + (data?.usage?.completion_tokens || 0)
  ) || 120; // fallback au cas où

  return { reply, tokensUsed: used };
}

// ===== Routes =====
app.get("/", (_req, res) => res.send("✅ API en ligne"));

// Solde utilisateur
app.get("/api/balance", (req, res) => {
  const email = String(req.query.email || "");
  const u = getUser(email);
  res.json({ free: u.free, paid: u.paid });
});

// Recharge factice (bouton “Ajouter des tokens”)
app.post("/api/topup", (req, res) => {
  const { email } = req.body || {};
  const u = getUser(email || "");
  const ADD = Number(process.env.TOPUP_AMOUNT || 1000); // par défaut +1000
  u.free += ADD;
  res.json({ ok: true, free: u.free, paid: u.paid, added: ADD });
});

// Chat IA
app.post("/api/chat", async (req, res) => {
  try {
    const { message, email, first } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message requis" });
    }

    const u = getUser(email || "");

    // Prompt système (style D + présentation si first)
    const systemPrompt =
`Tu es Philomène IA, assistant personnel polyvalent.
Style: clair, chaleureux, fiable, sans blabla inutile.
Langue: réponds dans la langue du message utilisateur (FR/EN/NL).
Donne des explications concrètes, des étapes si utile, et propose une action suivante quand pertinent.`;

    const firstGreeting =
`Bonjour 👋 Je suis **Philomène IA**, ton assistant perso.
Je peux t’aider pour tout: idées, rédaction, explications, dépannage, recettes…
Dis-moi ce qu’il te faut !`;

    const messages = [{ role: "system", content: systemPrompt }];
    if (first && u.greeted !== true) {
      messages.push({ role: "assistant", content: firstGreeting });
      u.greeted = true;
    }
    messages.push({ role: "user", content: message });

    // Appel OpenAI
    const { reply, tokensUsed } = await callOpenAI(messages);

    // Décrémentation d'après l'usage réel (tokensUsed)
    if (totalBalance(u) < tokensUsed) {
      // Pas assez → on ne consomme rien, on avertit
      return res.status(402).json({
        error: "Crédits insuffisants",
        needed: tokensUsed,
        free: u.free, paid: u.paid
      });
    }
    consume(u, tokensUsed);

    res.json({
      reply,
      tokensUsed,
      balance: { free: u.free, paid: u.paid }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// 404
app.use((_req, res) => res.status(404).json({ error: "Route non trouvée" }));

// Launch
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Backend Philomène IA en ligne sur port", PORT);
  console.log("ALLOW_ORIGINS =", rawAllow);
});
