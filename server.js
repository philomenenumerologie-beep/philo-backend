import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json()); // pas besoin de body-parser

// 🔑 Client OpenAI (ne cassera pas si la clé manque)
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
}) : null;

// 🩺 Santé / test
app.get("/", (req, res) => {
  res.send("✅ Philo Backend en ligne");
});

// 🤖 Route IA
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question) {
      return res.status(400).json({ error: "Champ 'question' manquant" });
    }

    // Si pas de clé => réponse locale de secours
    if (!openai) {
      return res.json({
        answer: "Backend OK (mode démo). Ajoute OPENAI_API_KEY sur Render pour activer l’IA.",
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Tu es une IA de Philomenia, concise et utile." },
        { role: "user", content: question }
      ]
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ✅ Render fournit PORT
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend démarré sur port ${PORT}`);
});
