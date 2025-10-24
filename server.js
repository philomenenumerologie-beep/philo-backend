import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();
import cors from "cors";
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: [
      "https://philomeneia.com",
      "https://www.philomeneia.com",
      "https://philomania.com",
      "https://www.philomania.com"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
// --- Clés API (à configurer dans Render → Environment Variables)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SERPER_API_KEY = process.env.SERPER_API_KEY;

// --- Fonction pour faire une recherche via Serper (actualités)
async function serperSearch(query) {
  const response = await fetch("https://google.serper.dev/news", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
  });

  const data = await response.json();
  if (!data.news || data.news.length === 0) {
    return "Aucun résultat d’actualité trouvé.";
  }

  // On prend les 3 premières actualités
  return data.news
    .slice(0, 3)
    .map((item) => `🗞️ ${item.title}\n🔗 ${item.link}`)
    .join("\n\n");
}

// --- Route principale pour discuter
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    // Si le message contient des mots-clés d’actualité
    if (/(actu|actualité|news|aujourd'hui|dernière minute|info)/i.test(message)) {
      const news = await serperSearch(message);
      return res.json({ reply: `Voici ce que j’ai trouvé :\n\n${news}` });
    }

    // Sinon : réponse classique OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: message }],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (error) {
    console.error("Erreur backend :", error);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// --- Lancement du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur en ligne sur le port ${PORT}`));
