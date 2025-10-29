import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// CORS dynamique depuis Render env
const allowedOrigins = (process.env.ALLOW_ORIGINS || "").split(",");

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.log("❌ CORS blocked:", origin);
    return callback(new Error("Not allowed by CORS"));
  }
}));

// Test simple : racine
app.get("/", (req, res) => res.send("✅ API en ligne !"));

// Balance test endpoint
app.get("/api/balance", (req, res) => {
  res.json({ free: 5000, paid: 0 });
});

// Chat simulation (on fera mieux après)
app.post("/api/chat", async (req, res) => {
  res.json({ reply: "Réponse test 🔧" });
});

// ✅ Port pour Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Backend Philomène IA en ligne sur port", PORT);
});
