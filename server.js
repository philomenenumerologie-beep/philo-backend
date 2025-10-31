import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// 🔑 Mets ta clé OpenAI ici
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Mémoire des conversations par user (simple en RAM)
const conversations = {};
const userTokens = {};

// Fonction pour compter les tokens (simulation simple)
function countTokens(text) {
  return Math.ceil(text.split(" ").length * 1.2);
}

app.post("/ask", async (req, res) => {
  try {
    const { message, userId } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message manquant." });
    }

    // Si pas d'userId, on crée un invité temporaire
    const id = userId || "guest";
    if (!conversations[id]) conversations[id] = [];
    if (!userTokens[id]) userTokens[id] = 5000; // tokens initiaux

    // Vérifie les tokens restants
    if (userTokens[id] <= 0) {
      return res.status(403).json({
        reply:
          "Vous avez utilisé tous vos tokens. Rechargez votre compte pour continuer 💎",
      });
    }

    // Ajoute le message de l'utilisateur à la conversation
    conversations[id].push({ role: "user", content: message });

    // Envoie la requête à OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: conversations[id],
        temperature: 0.7,
      }),
    });

    const data = await response.json();

    if (!data.choices || !data.choices.length) {
      throw new Error("Réponse vide d'OpenAI.");
    }

    const reply = data.choices[0].message.content;
    conversations[id].push({ role: "assistant", content: reply });

    // Décompte des tokens utilisés
    const used = countTokens(message + reply);
    userTokens[id] -= used;

    res.json({
      reply,
      remainingTokens: userTokens[id],
    });
  } catch (err) {
    console.error("Erreur backend:", err);
    res
      .status(500)
      .json({ reply: "Désolée, j'ai eu un problème réseau interne 😔" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Philomène backend en ligne sur le port ${PORT}`);
});
