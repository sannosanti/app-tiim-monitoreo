# Site Monitor

Monitor de sitios web propio. Chequea tus URLs diariamente y envía un reporte por email.

## Qué hace

- Chequea todos los sitios en `sites.json` cada día a las 8am (hora Colombia)
- Envía un email con el estado de cada sitio (código HTTP, tiempo de respuesta)
- Asunto con alerta si hay sitios caídos: `🔴 1 sitio caído: Agrofertas`
- Guarda historial de los últimos 30 días en `log.json`
- Endpoint `POST /check` para forzar un chequeo manual

---

## Deploy en Railway

### 1. Subir el código

```bash
# Opción A: desde GitHub (recomendado)
# Sube esta carpeta a un repo en GitHub, luego en Railway:
# New Project → Deploy from GitHub repo

# Opción B: Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

### 2. Configurar variables de entorno en Railway

En tu proyecto Railway → **Variables** → agregar:

| Variable | Valor |
|---|---|
| `EMAIL_TO` | tu@email.com |
| `EMAIL_FROM` | monitor@tudominio.com |
| `SMTP_HOST` | smtp.gmail.com |
| `SMTP_PORT` | 587 |
| `SMTP_USER` | tu@gmail.com |
| `SMTP_PASS` | tu_app_password |
| `CHECK_CRON` | 0 8 * * * |

### 3. Agregar tus sitios

Edita `sites.json` con tus URLs reales:

```json
[
  { "name": "Mi sitio",  "url": "https://misitioweb.com" },
  { "name": "Mi API",    "url": "https://api.misitioweb.com" }
]
```

---

## SMTP recomendado: Resend (gratis)

1. Crea cuenta en [resend.com](https://resend.com) — gratis hasta 3000 emails/mes
2. Crea un API Key
3. Configura:
   - `SMTP_HOST` = `smtp.resend.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = `resend`
   - `SMTP_PASS` = tu API key de Resend

## Gmail (alternativa)

1. Activa verificación en 2 pasos en tu cuenta Google
2. Ve a [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Crea una contraseña de aplicación
4. Usa esa contraseña en `SMTP_PASS`

---

## Uso

```bash
# Instalar dependencias
npm install

# Correr localmente
node index.js

# Forzar chequeo manual (desde cualquier cliente HTTP)
curl -X POST http://localhost:3000/check

# Ver último reporte
curl http://localhost:3000/
```

---

## Estructura

```
site-monitor/
├── index.js        # Servidor principal
├── sites.json      # Tus sitios (editar aquí)
├── log.json        # Historial auto-generado
├── package.json
└── .env.example    # Variables de entorno de ejemplo
```
