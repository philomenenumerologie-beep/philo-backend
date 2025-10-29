// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// Log simple pour vérifier que Render charge bien les vars
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("ALLOW_ORIGINS =", process.env.ALLOW_ORIGINS);

// ---------- Middlewares ----------
app.use(express.json());

// ----- CORS dynamique depuis ALLOW_ORIGINS -----
const allowlist = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

console.log("CORS allowlist:", allowlist);

const corsOptions = {
  origin(origin, callback) {
    // Autorise les requêtes sans Origin (ex: tests direct via navigateur)
    if (!origin) return callback(null, true);

    const normalized = origin.toLowerCase();
    const isAllowed = allowlist.includes(normalized);
    if (isAllowed) return callback(null, true);

    console.warn("❌ CORS blocked:", origin);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // préflight

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.send("✅ API en ligne");
});

// Endpoint de test du frontend (affiche 5000/0)
app.get("/api/balance", (_req, res) => {
  res.json({ free: 5000, paid: 0 });
});

// Endpoint chat (placeholder)
app.post("/api/chat", async (req, res) => {
  try {
    const { message, email } = req.body || {};
    console.log("Chat request:", { email, message });

    // Ici on répond en dur. Plus tard on branchera le vrai modèle.
    res.json({ reply: "Réponse test 🔧" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// 404 propre
app.use((_req, res) => {
  res.status(404).json({ error: "Route non trouvée" });
});

// ---------- Lancement ----------
app.listen(PORT, () => {
  console.log(`✅ Backend Philomène IA en ligne sur port ${PORT}`);
});
