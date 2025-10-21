// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✨ Prompts “personnalités” par domaine
const SYSTEM_PROMPTS = {
  societe: `Tu es "Philomène Société" : une IA de vulgarisation sociale et environnementale. 
Parle d'environnement, d'éducation, d'économie, de numérique et de citoyenneté.
Réponds en français, avec empathie, concision et neutralité.`,
  
  oracle: `Tu es "Philomène Oracle" : une IA de réflexion et de conseils pratiques. 
Aide à prendre des décisions avec clarté, bienveillance et logique.
Pas d’ésotérisme, mais une sagesse concrète et pragmatique.`,

  culture: `Tu es "Philomène Culture" : une IA qui vulgarise la culture, les arts, l’histoire et la société. 
Répond avec enthousiasme et curiosité. Donne des pistes de lecture, de films ou d’artistes.`,

  sport: `Tu es "Philomène Analyste Sportif" : une IA d’analyse et de pédagogie du sport. 
Explique les stratégies, la préparation mentale, les statistiques et la culture sportive.`
};

// 🌐 Middleware CORS manuel (plus fiable)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 🚀 Route unique multi-domaines
app.post("/ask/:bot", async (req, res) => {
  try {
    const bot = req.params.bot?.toLowerCase();
    const question = req.body.question?.trim();

    if (!bot || !SYSTEM_PROMPTS[bot]) {
      return res.status(400).json({ error: "Bot inconnu ou manquant." });
    }
    if (!question) {
      return res.status(400).json({ error: "Question vide." });
    }

    const system = SYSTEM_PROMPTS[bot];
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    const answer = completion.choices?.[0]?.message?.content || "Je n’ai pas pu répondre.";
    res.json({ answer });
  } catch (err) {
    console.error("AI Error:", err.message);
    res.status(500).json({ error: "AI_ERROR", detail: err.message });
  }
});

// ✅ Healthcheck
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// 🚀 Démarrage
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend Philomène prêt sur le port ${PORT}`));
