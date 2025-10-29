// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// ===== CORS robuste (gère www., espaces, retours à la ligne) =====
const raw = process.env.ALLOW_ORIGINS || "";
const allowedHosts = raw
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(u => {
    try {
      const { hostname } = new URL(u);
      return hostname.toLowerCase();
    } catch {
      return null;
    }
  })
  .filter(Boolean);

function hostFromOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname.toLowerCase();
  } catch {
    return "";
  }
}
const stripWww = h => h.replace(/^www\./, "");

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // Postman/cURL
    const h = hostFromOrigin(origin);
    const ok =
      allowedHosts.includes(h) ||
      allowedHosts.map(stripWww).includes(stripWww(h));
    if (ok) return cb(null, true);
    console.log("❌ CORS blocked:", origin, "allowed:", allowedHosts);
    cb(new Error("Not allowed by CORS"));
  }
}));

// ===== Routes de test & endpoints =====
app.get("/", (req, res) => {
  res.send("✅ API en ligne");
});

app.get("/api/balance", (req, res) => {
  res.json({ free: 5000, paid: 0 });
});

app.post("/api/chat", async (req, res) => {
  const { message, email } = req.body || {};
  console.log("Chat request:", { email, message });
  // TODO: appeler ton LLM ici
  res.json({ reply: "Réponse test 🔧" });
});

// ===== Démarrage (Render attache le port via PORT) =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend Philomène IA en ligne sur port ${PORT}`);
});
