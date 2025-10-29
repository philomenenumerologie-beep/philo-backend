<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Philomène IA Messenger – GPT</title>
  <script async crossorigin="anonymous"
    data-clerk-publishable-key="pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js">
  </script>
  <style>
    :root{--bg:#0c1a24;--fg:#eaf2f7;--muted:#9bb3c2;--btn:#3b82f6;--card:#0f2430}
    *{box-sizing:border-box} body{
      margin:0;background:var(--bg);color:var(--fg);font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Arial, sans-serif;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px
    }
    .wrap{width:100%;max-width:780px}
    .card{background:rgba(15,36,48,.9);backdrop-filter: blur(6px);border:1px solid rgba(255,255,255,.06);
      border-radius:16px;padding:28px 24px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size: clamp(28px, 5.5vw, 42px)}
    p{margin:0 0 18px;color:var(--muted)}
    .row{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0 20px}
    button{appearance:none;border:none;background:var(--btn);color:#fff;padding:12px 16px;border-radius:10px;font-weight:600;cursor:pointer}
    .ghost{background:#2b2b2b}
    .pill{display:inline-block;margin-top:8px;color:#cde;opacity:.9}
    .badge{display:inline-flex;gap:8px;align-items:center;font-weight:700}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace}
    #balance{font-weight:800}
    .warn{color:#ffcf6c}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Philomène IA Messenger – GPT ✨</h1>
      <p>Assistant personnel tout-en-un. À l’inscription, vous recevez <span class="badge">🎁 <span id="gift">5000</span> tokens</span>.</p>

      <div class="row" id="authRow">
        <button id="btnSignUp">Créer un compte</button>
        <button class="ghost" id="btnSignIn">Se connecter</button>
        <span class="pill mono" id="who"></span>
      </div>

      <p class="mono">Solde: <span id="balance">0</span> (gratuit) • <span id="paid">0</span> (payant)</p>
      <p id="status" class="warn mono"></p>
    </div>
  </div>

  <script>
    const API_BASE = "https://api.philomeneia.com"; // ← ton backend Render
    const giftEl = document.getElementById("gift");
    const whoEl = document.getElementById("who");
    const balEl = document.getElementById("balance");
    const paidEl = document.getElementById("paid");
    const statusEl = document.getElementById("status");

    async function call(method, path, body) {
      const res = await fetch(API_BASE + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    }

    function showStatus(msg){ statusEl.textContent = msg || "" }

    // Clerk
    window.addEventListener("load", async () => {
      await window.Clerk.load();

      const btnUp = document.getElementById("btnSignUp");
      const btnIn = document.getElementById("btnSignIn");

      btnUp.onclick = () => window.Clerk.openSignUp();
      btnIn.onclick = () => window.Clerk.openSignIn();

      // Quand la session change, on crédite et on affiche le solde
      window.Clerk.addListener(async ({ session }) => {
        try{
          if(!session){ whoEl.textContent = ""; balEl.textContent="0"; paidEl.textContent="0"; return; }
          const user = await window.Clerk.user;
          const email = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress;
          if(!email){ showStatus("Pas d’email trouvé."); return; }

          whoEl.textContent = email;

          // 1) init (crédite 5000 si nouveau)
          await call("POST","/init",{ email });

          // 2) récupère le solde
          const b = await call("GET", `/balance?email=${encodeURIComponent(email)}`);
          balEl.textContent = b.free ?? 0;
          paidEl.textContent = b.paid ?? 0;
          giftEl.textContent = "5000";
          showStatus("");
        }catch(e){
          showStatus("Erreur API (HTTP "+e.message+"). Vérifie le backend.");
        }
      });
    });
  </script>
</body>
</html>
