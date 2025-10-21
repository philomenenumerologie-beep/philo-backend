// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 OpenAI (clé à mettre sur Render)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 Profils (prompts) par IA
const IA_PROFILES = {
  oracle: "Tu es Philoménia – Oracle : guidance bienveillante, concise, actionable (3–5 points max).",
  sport: "Tu es Philoménia – Analyste Sportif : Contexte, Clés tactiques (3–5 puces), Tendance prudente.",
  culture: "Tu es Philoménia – Culture : 1 idée centrale, 3 bullet points utiles, 1 piste pour aller plus loin.",
  flash: "Tu es Philoménia – Flash Info : 3 bullets ultra concis et actionnables."
};

// 🧭 Route principale
app.get("/", (_req, res) => {
  res.send("✅ Philo Backend en ligne");
});

// 💬 Route d'IA principale
app.post("/ask", async (req, res) => {
  try {
    const question = (req.body?.question || "").slice(0, 2000);
    const ia = (req.body?.ia || "oracle").toLowerCase();

    if (!question) {
      return res.status(400).json({ error: "Question manquante" });
    }

    const system = IA_PROFILES[ia] || "Tu es Philoménia, utile et concise.";

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: question }
      ]
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() || "(pas de réponse)";
    res.json({ answer });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// 🚀 Lancer le serveur
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Backend lancé sur port ${PORT}`));
