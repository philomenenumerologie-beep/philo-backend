import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());

app.use(cors({
  origin: ["https://philomeneia.com", "https://www.philomeneia.com"]
}));

// Vérification que l’API tourne
app.get("/", (req, res) => {
  res.send("API Philomenia OK");
});

// Route principale pour discuter avec l’IA
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Missing message text" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "API key missing" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error(data.error);
      return res.status(500).json({ error: data.error.message });
    }

    const reply = data.choices?.[0]?.message?.content || "Réponse vide";
    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: "Request failed", details: err.message });
  }
});

// Port Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Philomenia backend is running on port ${PORT}`);
});
