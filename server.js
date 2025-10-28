import express from "express";
import fetch from "node-fetch";
import cors from "cors";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 10000;
// jetons gratuits pour invité (non connecté)
const FREE_ANON = Number(process.env.FREE_ANON || 10);
// jetons gratuits après inscription (on les expose pour l'UI)
const FREE_AFTER_SIGNUP = Number(process.env.FREE_AFTER_SIGNUP || 10);
// paiement actif (UI affiche le bouton)
const PAYMENT_ENABLED = String(process.env.PAYMENT_ENABLED || "false") === "true";

// ---------- APP ----------
const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://philomeneia.com", "https://www.philomeneia.com"],
  credentials: false
}));

// Petit compteur en mémoire par IP pour le mode invité
const usageByIp = new Map(); // key = req.ip, value = { used: number }

// ---------- ROUTES D’INFOS POUR L’UI ----------
app.get("/", (req, res) => {
  res.send("API Philomenia OK");
});

// Donne à l’UI les réglages (pour qu’elle sache que l’anonyme a des jetons)
app.get("/api/config", (req, res) => {
  res.json({
    paymentEnabled: PAYMENT_ENABLED,
    freeAnon: FREE_ANON,
    freeAfterSignup: FREE_AFTER_SIGNUP
  });
});

// Solde “courant” pour l’UI quand on est invité (non connecté)
app.get("/api/tokens", (req, res) => {
  const ip = req.ip;
  const used = usageByIp.get(ip)?.used || 0;
  const remaining = Math.max(FREE_ANON - used, 0);
  res.json({
    mode: "guest",
    free: remaining,
    paid: 0,
    total: remaining
  });
});

// ---------- CHAT ----------
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing message text" });
  }

  // Compte invité: vérifie les jetons restants
  const ip = req.ip;
  const used = usageByIp.get(ip)?.used || 0;
  if (used >= FREE_ANON) {
    return res.status(402).json({ error: "no_tokens_left" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "API key missing" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }]
      })
    });

    const data = await response.json();

    if (data?.error) {
      console.error("OpenAI error:", data.error);
      return res.status(502).json({ error: "openai_error", details: data.error });
    }

    const reply = data.choices?.[0]?.message?.content || "Réponse vide";

    // Décrémente 1 jeton invité
    usageByIp.set(ip, { used: used + 1 });

    res.json({ reply });
  } catch (err) {
    console.error("Request failed:", err);
    res.status(500).json({ error: "request_failed", details: err.message });
  }
});

// ---------- LANCEMENT ----------
app.listen(PORT, () => {
  console.log(`Philomenia backend is running on port ${PORT}`);
});
