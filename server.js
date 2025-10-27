import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://www.philomeneia.com", "https://philomeneia.com"]
}));

app.get("/", (req, res) => {
  res.send("OK");
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "missing_message" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "missing_api_key" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "Tu es Philomène, assistant francophone. Réponds clairement et utilement." },
          { role: "user", content: message }
        ]
      })
    });

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || "Désolé, petite erreur 😅";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "openai_error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Philomene backend is running on", port);
});
