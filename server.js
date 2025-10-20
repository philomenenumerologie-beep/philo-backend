// server.js
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// ⚙️ Client OpenAI (clé à mettre dans Render: OPENAI_API_KEY)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ping de santé (permet à Render de voir que l'app tourne)
app.get("/", (_req, res) => {
  res.send("✅ Philo Backend en ligne");
});

// Route IA
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body ?? {};
    if (!question) return res.status(400).json({ error: "Paramètre 'question' manquant" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "Tu es l’IA de Philomenia, claire et utile." },
        { role: "user", content: question }
      ]
    });

    const answer = completion.choices?.[0]?.message?.content ?? "Aucune réponse.";
    res.json({ answer });
  } catch (err) {
    console.error("AI error:", err);
    res.status(500).json({ error: "Erreur serveur", detail: String(err.message || err) });
  }
});

// Render injecte PORT — on l’utilise impérativement
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on :${PORT}`);
});
