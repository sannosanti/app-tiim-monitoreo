const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const SITES_FILE = path.join(__dirname, "sites.json");
const LOG_FILE   = path.join(__dirname, "log.json");

// ─── Config ───────────────────────────────────────────────────────────────────
const EMAIL_FROM     = process.env.EMAIL_FROM;
const EMAIL_TO       = process.env.EMAIL_TO;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CHECK_CRON     = process.env.CHECK_CRON  || "0 * * * *"; // cada hora
const REPORT_CRON    = process.env.REPORT_CRON || "0 8 * * *"; // reporte 8am
const PORT           = process.env.PORT || 3000;

const BAD_BODY_KEYWORDS = [
  "service unavailable",
  "unavailable",
  "error 503",
  "site is down",
  "temporarily unavailable",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadSites() {
  try { return JSON.parse(fs.readFileSync(SITES_FILE, "utf8")); }
  catch { return []; }
}

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return {}; }
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
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { if (body.length < 10240) body += chunk; });
        res.on("end", () => {
          const statusOk = res.statusCode >= 200 && res.statusCode < 400;
          const bodyLower = body.toLowerCase();
          const bodyBad = BAD_BODY_KEYWORDS.some((kw) => bodyLower.includes(kw));
          resolve({
            name: site.name,
            url: site.url,
            status: statusOk && !bodyBad ? "up" : "down",
            code: res.statusCode,
            ms: elapsed,
            checkedAt: new Date().toISOString(),
            ...(bodyBad && { error: "Contenido indica caída" }),
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({ name: site.name, url: site.url, status: "down", code: null, ms: null, error: "Timeout", checkedAt: new Date().toISOString() });
    });

    req.on("error", (err) => {
      resolve({ name: site.name, url: site.url, status: "down", code: null, ms: null, error: err.message, checkedAt: new Date().toISOString() });
    });
  });
}

// Reintenta hasta 2 veces con 5s de espera antes de marcar como caído
async function checkSiteWithRetry(site) {
  let result = await checkSite(site);
  for (let i = 0; i < 2 && result.status === "down"; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    result = await checkSite(site);
  }
  return result;
}

// ─── Chequeo de todos los sitios ──────────────────────────────────────────────
async function checkAll() {
  const sites = loadSites();
  if (!sites.length) {
    console.log("No hay sitios configurados en sites.json");
    return [];
  }

  console.log(`[${new Date().toISOString()}] Chequeando ${sites.length} sitios...`);
  const results = await Promise.all(sites.map(checkSiteWithRetry));

  const log = loadLog();
  const today = new Date().toISOString().split("T")[0];
  log[today] = results;
  const keys = Object.keys(log).sort();
  if (keys.length > 30) keys.slice(0, keys.length - 30).forEach((k) => delete log[k]);
  saveLog(log);

  results.forEach((r) => {
    const icon = r.status === "up" ? "✅" : "❌";
    console.log(`  ${icon} ${r.name} — ${r.code || r.error} (${r.ms ? r.ms + "ms" : "—"})`);
  });

  return results;
}

// ─── Email via Resend ─────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !EMAIL_TO) {
    console.log("Resend no configurado, omitiendo email.");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM || "Site Monitor <monitor@resend.dev>",
      to: EMAIL_TO.split(",").map((e) => e.trim()),
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }

  console.log(`Email enviado a ${EMAIL_TO}`);
}

function buildResultRows(results) {
  return results.map((r) => {
    const color = r.status === "up" ? "#1D9E75" : "#E24B4A";
    const icon  = r.status === "up" ? "✅" : "❌";
    return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-weight:500">${icon} ${r.name}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:13px">${r.url}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:${color};font-weight:500">${r.status === "up" ? "En línea" : "Caído"}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px">${r.code || r.error || "—"}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666">${r.ms ? r.ms + " ms" : "—"}</td>
    </tr>`;
  }).join("");
}

// Reporte diario completo — se envía siempre a las 8am
async function sendDailyReport(results) {
  const up   = results.filter((r) => r.status === "up");
  const down = results.filter((r) => r.status === "down");
  const date = new Date().toLocaleDateString("es-CO", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const html = `
  <!DOCTYPE html><html>
  <body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8">
      <div style="background:#111;padding:24px 28px">
        <h1 style="color:#fff;margin:0;font-size:20px">🔍 Reporte diario de sitios</h1>
        <p style="color:#888;margin:6px 0 0;font-size:13px">${date}</p>
      </div>
      <div style="display:flex;border-bottom:1px solid #f0f0f0">
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
          <tbody>${buildResultRows(results)}</tbody>
        </table>
      </div>
      <div style="padding:16px 28px;background:#f8f8f8;border-top:1px solid #f0f0f0;font-size:12px;color:#aaa;text-align:center">
        Monitor propio · Generado automáticamente
      </div>
    </div>
  </body></html>`;

  const downNames = down.map((r) => r.name).join(", ");
  const subject = down.length > 0
    ? `🔴 ${down.length} sitio(s) caído(s): ${downNames}`
    : `✅ Todos los sitios en línea — Reporte diario`;

  await sendEmail(subject, html);
}

// Alerta inmediata — solo sitios caídos, sin esperar al reporte diario
async function sendAlert(down) {
  const time = new Date().toLocaleTimeString("es-CO", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota",
  });

  const html = `
  <!DOCTYPE html><html>
  <body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8">
      <div style="background:#C0392B;padding:24px 28px">
        <h1 style="color:#fff;margin:0;font-size:20px">🚨 Alerta: sitio(s) caído(s)</h1>
        <p style="color:#f5b7b1;margin:6px 0 0;font-size:13px">Detectado a las ${time} (hora Colombia)</p>
      </div>
      <div style="padding:24px 28px">
        <p style="margin:0 0 16px;color:#444;font-size:14px">
          Los siguientes sitios <strong>no respondieron correctamente</strong> después de 3 intentos:
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f8f8f8">
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">Sitio</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">URL</th>
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888;font-weight:500">Error</th>
            </tr>
          </thead>
          <tbody>
            ${down.map((r) => `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-weight:500">❌ ${r.name}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:13px">${r.url}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px;color:#E24B4A">${r.code || r.error || "—"}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div style="padding:16px 28px;background:#f8f8f8;border-top:1px solid #f0f0f0;font-size:12px;color:#aaa;text-align:center">
        Monitor propio · Alerta automática
      </div>
    </div>
  </body></html>`;

  const names = down.map((r) => r.name).join(", ");
  await sendEmail(`🚨 ${down.length} sitio(s) caído(s): ${names}`, html);
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────
async function runHourlyCheck() {
  const results = await checkAll();
  const down = results.filter((r) => r.status === "down");
  if (down.length) await sendAlert(down);
}

async function runDailyReport() {
  const results = await checkAll();
  if (results.length) await sendDailyReport(results);
}

// ─── Cron ─────────────────────────────────────────────────────────────────────
cron.schedule(CHECK_CRON,  runHourlyCheck,  { timezone: "America/Bogota" });
cron.schedule(REPORT_CRON, runDailyReport,  { timezone: "America/Bogota" });
console.log(`Chequeo horario: ${CHECK_CRON} | Reporte diario: ${REPORT_CRON} (Bogotá)`);

// ─── HTTP server ──────────────────────────────────────────────────────────────
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
    runDailyReport();

  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`POST /check para forzar reporte manual`);
});
