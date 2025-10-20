import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔑 Création du client OpenAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // clé ajoutée dans Render
});

// 🔮 Route principale (test rapide)
app.get("/", (req, res) => {
  res.send("✅ Philo Backend en ligne et prêt à répondre !");
});

// 🧠 Route IA
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // modèle léger, parfait pour ton IA
      messages: [
        { role: "system", content: "Tu es l’IA de Philomenia, spirituelle et bienveillante." },
        { role: "user", content: question },
      ],
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (error) {
    console.error("Erreur :", error);
    res.status(500).json({ error: "Erreur de l’Oracle." });
  }
});

// 🚀 Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur Philo en ligne sur le port ${PORT}`));
