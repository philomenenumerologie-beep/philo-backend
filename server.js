import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Tu es Philomenia, une IA douce, intuitive et inspirante." },
        { role: "user", content: question }
      ],
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: "Erreur : " + error.message });
  }
});

app.listen(3000, () => console.log("🚀 Serveur Philomenia lancé sur le port 3000"));
