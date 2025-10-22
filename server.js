// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Configuration OpenAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🧠 Personnalité de Philomene GPT
const SYSTEM_PROMPT = `
Tu es "Philomene GPT", un assistant français clair et bienveillant.
Règles :
– Réponds en français, simplement, avec des explications concrètes.
– Donne des exemples précis si c’est utile.
– Pas d’affirmations non étayées.
– Si on te demande un résumé, rends-le actionnable et synthétique.
`;

// 🧩 Fonction pour transformer les images envoyées
function dataUrlToImageContent(dataUrl) {
  if (!dataUrl) return null;
  return { type: "image_url", image_url: { url: dataUrl } };
}

// 🚀 Route principale : chat
app.post("/api/chat", async (req, res) => {
  try {
    const { plan = "mini", messages = [] } = req.body;

    const model =
      plan === "pro"
        ? "gpt-4o"
        : plan === "mini"
        ? "gpt-4o-mini"
        : "gpt-3.5-turbo";

    const formatted = messages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content
        : [{ type: "text", text: m.content }],
    }));

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...formatted,
      ],
    });

    res.json({
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    console.error("Erreur serveur:", error);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// 🌍 Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur le port ${PORT}`);
});
