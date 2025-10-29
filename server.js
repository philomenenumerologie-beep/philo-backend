import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Test endpoint
app.get("/api/test", (req, res) => {
  res.json({ ok: true });
});

// Chat endpoint de test
app.post("/api/chat", (req, res) => {
  const { message } = req.body;
  res.json({ reply: "Réponse du backend : " + message });
});

// Balance endpoint de test
app.get("/api/balance", (req, res) => {
  res.json({ free: 5000, paid: 0 });
});

// Démarrage
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Philo Backend running on port", PORT);
});
