import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch"; // si besoin côté node < 22
dotenv.config();

const app = express();
app.use(express.json());

// CORS dynamiques depuis Render
const allowedOrigins = (process.env.ALLOW_ORIGINS || "").split(",").map(s => s.trim());
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.log("❌ CORS blocked:", origin);
    return callback(new Error("Not allowed by CORS"));
  }
}));

/* ---------- Mini “base de données” token (à remplacer plus tard par Redis/DB) ---------- */
const FREE_AFTER_SIGNUP = Number(process.env.FREE_AFTER_SIGNUP || 5000);
const FREE_ANON         = Number(process.env.FREE_ANON || 1000);
const users = new Map(); // key = email, value = { free, paid, greeted }

/* Initialise un user s’il n’existe pas */
function ensureUser(email) {
  if (!users.has(email)) {
    users.set(email, { free: email ? FREE_AFTER_SIGNUP : FREE_ANON, paid: 0, greeted: false });
  }
  return users.get(email);
}

/* Décrémentation basique */
function consumeTokens(user, n) {
  const u = user;
  let rest = n;

  if (u.free >= rest) { u.free -= rest; rest = 0; }
  else {
    rest -= u.free;
    u.free = 0;
    if (u.paid >= rest) { u.paid -= rest; rest = 0; }
  }
  return rest === 0; // true si ok, false si insuffisant
}

/* ---------- API publics ---------- */

// Sanity root
app.get("/", (req, res) => res.send("✅ API en ligne"));

// Balance
app.get("/api/balance", (req, res) => {
  const email = req.query.email || "";
  const u = ensureUser(email);
  res.json({ free: u.free, paid: u.paid });
});

// Chat
app.post("/api/chat", async (req, res) => {
  try {
    const { message, email, first } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message requis" });
    }

    const user = ensureUser(email || "");
    // coût “forfaitaire” simplifié par message (tu pourras affiner avec tpm)
    const TOKENS_PER_MSG = 300;

    if (!consumeTokens(user, TOKENS_PER_MSG)) {
      return res.status(402).json({ error: "Crédits insuffisants", free: user.free, paid: user.paid });
    }

    // Prompt système : style D + présentation si first=true AND pas encore salué
    const systemIntro =
`Tu es Philomène IA, assistant personnel. Style direct, clair, chaleureux, utile.
- Français par défaut si l'utilisateur écrit en français, sinon adapte la langue.
- Donne des réponses structurées, avec étapes si besoin.
- Pas d’emphase inutile, pas de jargon technique non expliqué.
- Quand c’est pertinent, propose une action suivante.
`;

    const firstGreeting =
`Bonjour 👋 Je suis **Philomène IA**, ton assistant perso.
Je peux t’aider pour tout: idées, rédaction, explications, dépannage, recettes… Dis-moi ce qu’il te faut !`;

    const messages = [
      { role: "system", content: systemIntro },
    ];

    if (first && user.greeted !== true) {
      messages.push({ role: "assistant", content: firstGreeting });
      user.greeted = true;
    }

    messages.push({ role: "user", content: message });

    // Appel OpenAI (chat complet)
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",         // tu peux changer le modèle ici
        temperature: 0.4,
        messages
      })
    });

    if (!openaiResp.ok) {
      const txt = await openaiResp.text();
      console.error("OpenAI error:", txt);
      return res.status(500).json({ error: "Erreur OpenAI" });
    }

    const data = await openaiResp.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "Je n’ai rien reçu, réessaie stp.";

    return res.json({
      reply,
      tokensUsed: TOKENS_PER_MSG,
      balance: { free: user.free, paid: user.paid }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ---------- Lancement ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Backend sur port ${PORT}`));
