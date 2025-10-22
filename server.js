// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // pour images en base64

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🧠 Personnalité générale (sobre, utile, sans parti pris)
const SYSTEM_PROMPT = `
Tu es "Philomene GPT", un assistant français clair, concret et bienveillant.
Règles :
- Réponds en français, simplement, avec des étapes quand utile.
- Donne des exemples concrets. Si l’utilisateur joint une image, décris ce que tu vois et relie l’analyse à sa question.
- Pas d’affirmations non étayées. Si l’info est incertaine, dis-le.
- Si on te demande un résumé actionnable, donne une to-do list courte.
`;

// 🧩 Utilitaires pour images envoyées en Data URL
function dataUrlToImageContent(dataUrl){
  if (!dataUrl) return null;
  // OpenAI image input = { type:"image_url", image_url:{ url:"data:image/png;base64,..." } }
  return { type: "image_url", image_url: { url: dataUrl } };
}

app.post("/api/chat", async (req, res) => {
  try {
    const { plan = "mini", messages = [] } = req.body || {};
    // Plan → modèle
    const model = plan === "pro" ? "gpt-4o" : "gpt-4o-mini";

    // Transforme l’historique en messages OpenAI (support image)
    // Chaque tour : si image présente, on envoie un "content" mixte (texte + image)
    const formatted = [];
    for (const m of messages){
      const parts = [];
      if (m.content) parts.push({ type:"text", text: m.content });
      if (m.image)  parts.push(dataUrlToImageContent(m.image));
      // si aucun contenu => ignore
      if (parts.length===0) continue;

      formatted.push({ role: m.role, content: parts });
    }

    // Appel
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...formatted
      ],
      temperature: 0.6,
      max_tokens: 700
    });

    const reply = completion.choices?.[0]?.message?.content || "";
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI_ERROR", detail: err?.message || String(err) });
  }
});

// Santé
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Philomene backend prêt sur port", PORT));
