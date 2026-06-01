const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

const SITES_FILE = path.join(__dirname, "sites.json");
const LOG_FILE = path.join(__dirname, "log.json");

// ─── Config desde variables de entorno ───────────────────────────────────────
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const CHECK_CRON = process.env.CHECK_CRON || "0 8 * * *"; // Diario 8am
const PORT = process.env.PORT || 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadSites() {
  try {
    return JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Chequeo de un sitio ──────────────────────────────────────────────────────
function checkSite(site) {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = new URL(site.url);
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.get(
      site.url,
      { timeout: 10000, headers: { "User-Agent": "SiteMonitor/1.0" } },
      (res) => {
        const elapsed = Date.now() - start;
        resolve({
          name: site.name,
          url: site.url,
          status: res.statusCode >= 200 && res.statusCode < 400 ? "up" : "down",
          code: res.statusCode,
          ms: elapsed,
          checkedAt: new Date().toISOString(),
        });
        res.resume();
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({
        name: site.name,
        url: site.url,
        status: "down",
        code: null,
        ms: null,
        error: "Timeout",
        checkedAt: new Date().toISOString(),
      });
    });

    req.on("error", (err) => {
      resolve({
        name: site.name,
        url: site.url,
        status: "down",
        code: null,
        ms: null,
        error: err.message,
        checkedAt: new Date().toISOString(),
      });
    });
  });
}

// ─── Chequeo de todos los sitios ──────────────────────────────────────────────
async function checkAll() {
  const sites = loadSites();
  if (!sites.length) {
    console.log("No hay sitios configurados en sites.json");
    return [];
  }

  console.log(`[${new Date().toISOString()}] Chequeando ${sites.length} sitios...`);
  const results = await Promise.all(sites.map(checkSite));

  // Guardar log histórico
  const log = loadLog();
  const today = new Date().toISOString().split("T")[0];
  log[today] = results;

  // Mantener solo últimos 30 días
  const keys = Object.keys(log).sort();
  if (keys.length > 30) {
    keys.slice(0, keys.length - 30).forEach((k) => delete log[k]);
  }
  saveLog(log);

  results.forEach((r) => {
    const icon = r.status === "up" ? "✅" : "❌";
    console.log(`  ${icon} ${r.name} — ${r.code || r.error} (${r.ms ? r.ms + "ms" : "—"})`);
  });

  return results;
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendReport(results) {
  if (!SMTP_HOST || !EMAIL_TO) {
    console.log("SMTP no configurado, omitiendo email.");
    return;
  }

  const up = results.filter((r) => r.status === "up");
  const down = results.filter((r) => r.status === "down");
  const date = new Date().toLocaleDateString("es-CO", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const rows = results
    .map((r) => {
      const color = r.status === "up" ? "#1D9E75" : "#E24B4A";
      const icon = r.status === "up" ? "✅" : "❌";
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-weight:500">${icon} ${r.name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:13px">${r.url}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:${color};font-weight:500">${r.status === "up" ? "En línea" : "Caído"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px">${r.code || r.error || "—"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666">${r.ms ? r.ms + " ms" : "—"}</td>
      </tr>`;
    })
    .join("");

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8">
      <div style="background:#111;padding:24px 28px">
        <h1 style="color:#fff;margin:0;font-size:20px">🔍 Reporte diario de sitios</h1>
        <p style="color:#888;margin:6px 0 0;font-size:13px">${date}</p>
      </div>

      <div style="display:flex;gap:0;border-bottom:1px solid #f0f0f0">
        <div style="flex:1;padding:20px 28px;text-align:center;border-right:1px solid #f0f0f0">
          <div style="font-size:32px;font-weight:700;color:#1D9E75">${up.length}</div>
          <div style="font-size:13px;color:#888;margin-top:4px">En línea</div>
        </div>
        <div style="flex:1;padding:20px 28px;text-align:center;border-right:1px solid #f0f0f0">
          <div style="font-size:32px;font-weight:700;color:#E24B4A">${down.length}</div>
          <div style="font-size:13px;color:#888;margin-top:4px">Caídos</div>
        </div>
        <div style="flex:1;padding:20px 28px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:#333">${results.length}</div>
          <div style="font-size:13px;color:#888;margin-top:4px">Total</div>
        </div>
      </div>

      ${down.length > 0 ? `
      <div style="background:#fff5f5;border-left:4px solid #E24B4A;margin:20px 28px;padding:14px 16px;border-radius:4px">
        <strong style="color:#A32D2D">⚠️ ${down.length} sitio(s) caído(s):</strong>
        <ul style="margin:8px 0 0;padding-left:18px;color:#666">
          ${down.map((r) => `<li>${r.name} — ${r.url}</li>`).join("")}
        </ul>
      </div>` : `
      <div style="background:#f0faf5;border-left:4px solid #1D9E75;margin:20px 28px;padding:14px 16px;border-radius:4px">
        <strong style="color:#0F6E56">✅ Todos los sitios están en línea</strong>
      </div>`}

      <div style="padding:0 28px 28px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f8f8f8">
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">Sitio</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">URL</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">Estado</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">Código</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">Respuesta</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div style="padding:16px 28px;background:#f8f8f8;border-top:1px solid #f0f0f0;font-size:12px;color:#aaa;text-align:center">
        Monitor propio · Generado automáticamente
      </div>
    </div>
  </body>
  </html>`;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const downNames = down.map((r) => r.name).join(", ");
  const subject =
    down.length > 0
      ? `🔴 ${down.length} sitio(s) caído(s): ${downNames}`
      : `✅ Todos los sitios en línea — Reporte diario`;

  await transporter.sendMail({
    from: `"Site Monitor" <${EMAIL_FROM}>`,
    to: EMAIL_TO,
    subject,
    html,
  });

  console.log(`Email enviado a ${EMAIL_TO}`);
}

// ─── Job principal ────────────────────────────────────────────────────────────
async function runCheck() {
  const results = await checkAll();
  if (results.length) await sendReport(results);
}

// ─── Cron ─────────────────────────────────────────────────────────────────────
cron.schedule(CHECK_CRON, runCheck, { timezone: "America/Bogota" });
console.log(`Cron programado: ${CHECK_CRON} (Bogotá)`);

// ─── HTTP server (para Railway health check + dashboard básico) ───────────────
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const log = loadLog();
    const sites = loadSites();
    const lastKey = Object.keys(log).sort().pop();
    const lastResults = lastKey ? log[lastKey] : [];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      sites: sites.length,
      lastCheck: lastKey || null,
      results: lastResults,
    }, null, 2));

  } else if (req.method === "POST" && req.url === "/check") {
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Chequeo iniciado" }));
    runCheck();

  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`POST /check para forzar un chequeo manual`);
});
