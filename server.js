/* ================================
   Philomène IA – Backend simple & propre
================================== */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// Charger variables Render (tokens, clés, etc.)
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   Config Tokens par défaut
================================== */
const FREE_AFTER_SIGNUP = Number(process.env.FREE_AFTER_SIGNUP) || 5000;
const FREE_ANON = Number(process.env.FREE_ANON) || 1000;

/* ================================
   Endpoint API : Infos utilisateur
================================== */
app.get("/api/userinfo", async (req, res) => {
  try {
    // Exemple simple : retourne des tokens si nouveau compte
    const userEmail = req.query.email || "anonymous";

    let credits = userEmail.includes("@")
      ? FREE_AFTER_SIGNUP
      : FREE_ANON;

    res.json({
      email: userEmail,
      credits,
    });

  } catch (err) {
    console.error("Erreur UserInfo:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ================================
   Endpoint API : Chat avec GPT
================================== */
app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message || "Bonjour !";
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "Clé OpenAI manquante" });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();
    res.json({ reply: data.choices?.[0]?.message?.content || "Hmm 🤔" });

  } catch (err) {
    console.error("Erreur OpenAI:", err);
    res.status(500).json({ error: "Erreur GPT" });
  }
});

/* ================================
   Render Port configuration ✅
================================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Backend Philomène IA sur port " + PORT);
});
