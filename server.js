// server.js — Philomène IA (backend complet)
// Fonctions : CORS robuste • Solde tokens (mémoire) • Chat texte+photo (vision) • Recharge factice
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch"; // utile si Node < 22
dotenv.config();

const app = express();
app.use(express.json({ limit: "25mb" })); // pour images base64

// ===== CORS robuste (gère www., espaces, retours à la ligne) =====
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
const DEFAULT_FREE = Number(process.env.FREE_AFTER_SIGNUP || 5000);
const DEFAULT_ANON = Number(process.env.FREE_ANON || 0);
const TOPUP_AMOUNT = Number(process.env.TOPUP_AMOUNT || 1000);

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
  // on consomme d'abord le payant (tu peux inverser si tu préfères)
  if (u.paid >= rest) { u.paid -= rest; rest = 0; }
  else {
    rest -= u.paid; u.paid = 0;
    if (u.free >= rest) { u.free -= rest; rest = 0; }
  }
  return rest === 0;
}

// ===== OpenAI =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Appel OpenAI (texte seul OU texte+images via content[]).
async function callOpenAI({ systemPrompt, userText, images = [] }) {
  // messages → content (pour gpt-4o-mini vision)
  const msgUserParts = [];
  if (userText && userText.trim()) {
    msgUserParts.push({ type: "text", text: userText.trim() });
  }
  for (const dataUrl of images) {
    // dataUrl = "data:image/...;base64,AAAA"
    msgUserParts.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  if (!OPENAI_API_KEY) {
    // Mode dégradé si pas de clé
    const fake = images.length
      ? "J’ai bien reçu ta photo. (Mode test sans clé OpenAI)"
      : "Réponse de test (aucune clé OpenAI configurée).";
    return { reply: fake, tokensUsed: 50 };
  }

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: msgUserParts.length ? msgUserParts : [{ type: "text", text: userText || "" }] }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const txt = await r.text();
    console.error("OpenAI error:", txt);
    throw new Error("Erreur OpenAI");
  }

  const data = await r.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "Je n’ai rien reçu, réessaie.";
  const used = data?.usage?.total_tokens ??
               ((data?.usage?.prompt_tokens || 0) + (data?.usage?.completion_tokens || 0)) ||
               120; // fallback
  return { reply, tokensUsed: used };
}

// ===== Routes =====
app.get("/", (_req, res) => res.send("✅ API en ligne"));

app.get("/api/balance", (req, res) => {
  const email = String(req.query.email || "");
  const u = getUser(email);
  res.json({ free: u.free, paid: u.paid });
});

app.post("/api/topup", (req, res) => {
  const { email } = req.body || {};
  const u = getUser(email || "");
  u.free += TOPUP_AMOUNT;
  res.json({ ok: true, free: u.free, paid: u.paid, added: TOPUP_AMOUNT });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, email, first, images } = req.body || {};
    if ((!message || !message.trim()) && (!images || !images.length)) {
      return res.status(400).json({ error: "Message ou image requis" });
    }

    const u = getUser(email || "");

    // Prompt système (style D + prudence sur l'actualité)
    const systemPrompt =
`Tu es Philomène IA, assistant personnel polyvalent.
Style: clair, chaleureux, fiable, concret. Réponds dans la langue de l'utilisateur (FR/EN/NL).
Si la question touche à des sujets évolutifs (actualité, politique, sport, météo, prix),
répond au présent avec prudence ("d'après mes dernières infos disponibles, ... cela peut avoir évolué récemment")
et propose de vérifier si besoin. Donne des étapes/actionnables quand utile.`;

    // Intro à la 1re interaction
    let userText = message || "";
    if (first && u.greeted !== true) {
      userText =
        "Bonjour 👋 Je suis **Philomène IA**, ton assistant perso. " +
        "Je peux t’aider pour tout: idées, rédaction, explications, dépannage, recettes… " +
        "Dis-moi ce qu’il te faut !\n\n" +
        (message || "");
      u.greeted = true;
    }

    // Appel OpenAI (vision si images[])
    const { reply, tokensUsed } = await callOpenAI({
      systemPrompt,
      userText,
      images: Array.isArray(images) ? images : []
    });

    // Décrémentation d’après usage réel
    if (totalBalance(u) < tokensUsed) {
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

// Lancement
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Backend Philomène IA en ligne sur port", PORT);
  console.log("ALLOW_ORIGINS =", rawAllow);
});
