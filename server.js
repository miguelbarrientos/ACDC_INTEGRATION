/* ============================================================
   ACDC Demo — Server-side proxy (Node >=18, Express)
   Mantiene credenciales, OAuth y access tokens fuera del navegador.
   ============================================================ */

'use strict';

const { randomUUID } = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const app = express();

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');

const DEFAULT_API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com'
};

const ENV_PREFIX = {
  sandbox: 'SANDBOX',
  live: 'LIVE'
};

const DEFAULT_CUSTOMER_ID = 'testcustomer-2026';

// NOTA DE SEGURIDAD: este DEFAULT_ENV se escribe en el .env del usuario la
// primera vez que arranca el proyecto si no existe uno. NUNCA debe incluir
// credenciales Live reales: cualquier persona que clone el repo las recibiría.
// Las credenciales Sandbox aquí son demo pública con fines de prueba.
// El usuario completa las credenciales Live desde el panel CREDS de la UI o
// editando manualmente su .env (que está en .gitignore).
const DEFAULT_ENV = `# PayPal Sandbox credentials (demo - reemplaza con las tuyas)
SANDBOX_CLIENT_ID=AetBG_tJkcdYQ8tzjbBSTeSXUC4TpV8wDjIhEcdeIprHKMa4daLFsraioWHNMZQ8qsTj6H_Bao1_BRF6
SANDBOX_CLIENT_SECRET=EEpDEyOsZf98F_dd-brLGIkSSoeo6VfYzWXvYu-IEXwqrMlugzcvGcWVTEbJURLKYJF3BPvORTyvxHq0
SANDBOX_API_BASE=${DEFAULT_API_BASE.sandbox}
SANDBOX_MERCHANT_ID=SCNFPFK46FW9L

# PayPal Live credentials (vacías por seguridad - complétalas desde el panel CREDS)
LIVE_CLIENT_ID=
LIVE_CLIENT_SECRET=
LIVE_API_BASE=${DEFAULT_API_BASE.live}
LIVE_MERCHANT_ID=

# Server
PORT=3000
CUSTOMER_ID=${DEFAULT_CUSTOMER_ID}
`;

// Llaves reconocidas al reescribir el .env; cualquier otra clave extra se preserva al final.
const ENV_FILE_KEYS = [
  'SANDBOX_CLIENT_ID',
  'SANDBOX_CLIENT_SECRET',
  'SANDBOX_API_BASE',
  'SANDBOX_MERCHANT_ID',
  'LIVE_CLIENT_ID',
  'LIVE_CLIENT_SECRET',
  'LIVE_API_BASE',
  'LIVE_MERCHANT_ID',
  'PORT',
  'CUSTOMER_ID'
];

// Crea el .env con valores demo la primera vez que se arranca el proyecto.
function ensureEnvExists() {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, DEFAULT_ENV, { mode: 0o600 });
    console.log(`[server] .env not found - generated default at ${ENV_PATH}`);
  }
}

// Lee y parsea el .env actual como objeto clave-valor.
function readEnvFile() {
  ensureEnvExists();
  return dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
}

// Serializa una clave y su valor en formato KEY=value para el .env.
function formatEnvLine(key, value) {
  return `${key}=${String(value ?? '')}`;
}

// Reescribe el .env preservando el orden estándar de claves y añadiendo extras al final.
function writeEnvFile(parsed) {
  const lines = [
    '# PayPal Sandbox credentials',
    formatEnvLine('SANDBOX_CLIENT_ID', parsed.SANDBOX_CLIENT_ID),
    formatEnvLine('SANDBOX_CLIENT_SECRET', parsed.SANDBOX_CLIENT_SECRET),
    formatEnvLine('SANDBOX_API_BASE', parsed.SANDBOX_API_BASE || DEFAULT_API_BASE.sandbox),
    formatEnvLine('SANDBOX_MERCHANT_ID', parsed.SANDBOX_MERCHANT_ID),
    '',
    '# PayPal Live credentials',
    formatEnvLine('LIVE_CLIENT_ID', parsed.LIVE_CLIENT_ID),
    formatEnvLine('LIVE_CLIENT_SECRET', parsed.LIVE_CLIENT_SECRET),
    formatEnvLine('LIVE_API_BASE', parsed.LIVE_API_BASE || DEFAULT_API_BASE.live),
    formatEnvLine('LIVE_MERCHANT_ID', parsed.LIVE_MERCHANT_ID),
    '',
    '# Server',
    formatEnvLine('PORT', parsed.PORT || process.env.PORT || '3000'),
    formatEnvLine('CUSTOMER_ID', parsed.CUSTOMER_ID || process.env.CUSTOMER_ID || DEFAULT_CUSTOMER_ID)
  ];

  const known = new Set(ENV_FILE_KEYS);
  const extraKeys = Object.keys(parsed).filter((key) => !known.has(key)).sort();
  if (extraKeys.length) {
    lines.push('', '# Other settings');
    extraKeys.forEach((key) => lines.push(formatEnvLine(key, parsed[key])));
  }

  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, { mode: 0o600 });
}

// Aplica los pares clave-valor del .env al proceso actual (process.env) sin reiniciar.
function applyEnvValues(parsed) {
  Object.entries(parsed).forEach(([key, value]) => {
    process.env[key] = String(value ?? '');
  });
}

// Devuelve las credenciales guardadas en el .env como objeto estructurado para la UI.
function readCredentialsFromFile() {
  const e = readEnvFile();
  return {
    customerId: e.CUSTOMER_ID || DEFAULT_CUSTOMER_ID,
    sandbox: {
      clientId: e.SANDBOX_CLIENT_ID || '',
      clientSecret: e.SANDBOX_CLIENT_SECRET || '',
      merchantId: e.SANDBOX_MERCHANT_ID || ''
    },
    live: {
      clientId: e.LIVE_CLIENT_ID || '',
      clientSecret: e.LIVE_CLIENT_SECRET || '',
      merchantId: e.LIVE_MERCHANT_ID || ''
    }
  };
}

ensureEnvExists();
dotenv.config({ path: ENV_PATH });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Normaliza el parámetro de entorno: cualquier valor distinto de "live" resulta en "sandbox".
function normalizeEnv(env) {
  return env === 'live' ? 'live' : 'sandbox';
}

// Lee las variables de entorno del proceso para el entorno solicitado (sandbox o live).
function readConfig(envName) {
  const env = normalizeEnv(envName);
  const prefix = ENV_PREFIX[env];
  return {
    env,
    clientId: process.env[`${prefix}_CLIENT_ID`] || '',
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || '',
    apiBase: process.env[`${prefix}_API_BASE`] || DEFAULT_API_BASE[env],
    merchantId: process.env[`${prefix}_MERCHANT_ID`] || '',
    customerId: process.env.CUSTOMER_ID || DEFAULT_CUSTOMER_ID
  };
}

// Como readConfig pero lanza error 500 si faltan credenciales obligatorias.
function cfg(envName) {
  const config = readConfig(envName);
  const missing = [];
  if (!config.clientId) missing.push(`${ENV_PREFIX[config.env]}_CLIENT_ID`);
  if (!config.clientSecret) missing.push(`${ENV_PREFIX[config.env]}_CLIENT_SECRET`);
  if (!config.merchantId) missing.push(`${ENV_PREFIX[config.env]}_MERCHANT_ID`);

  if (missing.length) {
    const err = new Error(`Missing PayPal configuration: ${missing.join(', ')}`);
    err.status = 500;
    throw err;
  }

  return config;
}

// Cache en memoria del access_token por entorno. Se invalida al guardar nuevas credenciales
// y se renueva automáticamente cuando quedan menos de 60 s para su expiración.
const tokenCache = { sandbox: null, live: null };

// Obtiene un access_token válido para el entorno solicitado.
// Usa el cache si el token no ha expirado (con 60 s de margen); si no, hace un nuevo OAuth.
// Siempre solicita response_type=id_token para obtener el id_token que necesita el SDK JS.
async function getAccessToken(envName) {
  const c = cfg(envName);
  const now = Date.now();
  const hit = tokenCache[c.env];
  if (hit && hit.expiresAt - 60_000 > now) return hit;

  const auth = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const response = await fetch(`${c.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`
    },
    body: 'grant_type=client_credentials&response_type=id_token'
  });

  const text = await response.text();
  const data = parseBody(text);

  if (!response.ok) {
    const err = new Error(`OAuth ${response.status}: ${JSON.stringify(data)}`);
    err.status = response.status;
    err.paypalData = data;
    throw err;
  }

  const entry = {
    accessToken: data.access_token,
    idToken: data.id_token || '',
    paypalResponse: data,
    expiresAt: now + Number(data.expires_in || 300) * 1000
  };
  tokenCache[c.env] = entry;
  return entry;
}

// Intenta parsear el body de respuesta como JSON; si falla, devuelve el texto crudo.
function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

// Elimina headers con valor falsy para no enviar cabeceras vacías a PayPal.
function removeEmptyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
}

// Construye los headers base para llamadas autenticadas a la API REST de PayPal.
function bearerHeaders(accessToken, extra = {}) {
  return removeEmptyHeaders({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...extra
  });
}

// Wrapper de fetch que devuelve { status, ok, data } con el body ya parseado.
async function paypalFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    data: parseBody(text)
  };
}

// Reenvía la respuesta de PayPal al cliente conservando el status code original.
function sendPayPal(res, { status, data }) {
  if (status === 204) {
    res.status(204).end();
    return;
  }
  res.status(status).json(data ?? {});
}

// Valida que el CMID cumpla el contrato de PayPal: alfanumérico, 1–32 caracteres, sin guiones.
function validateCmid(cmid) {
  return typeof cmid === 'string' && /^[a-zA-Z0-9]{1,32}$/.test(cmid);
}

// Devuelve el requestId recibido o genera uno nuevo; el mismo UUID se reutiliza en reintentos.
function paypalRequestId(requestId) {
  return requestId || randomUUID();
}

// Construye el header PayPal-Mock-Response para simular declines en Sandbox.
function mockHeader(mockResponse) {
  return mockResponse
    ? { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: mockResponse }) }
    : {};
}

function maskToken(value) {
  if (typeof value !== 'string') return value;
  return `${value.slice(0, 5)}${'*'.repeat(Math.max(value.length - 5, 0))}`;
}

function oauthResponseForLog(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    access_token: maskToken(data.access_token),
    id_token: data.id_token ? '[redacted]' : undefined
  };
}

// Envuelve handlers async para capturar errores y responder con JSON en lugar de crashear.
function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status || 500;
      const body = { error: error.message || 'Server error' };
      if (error.paypalData) body._log = { response: oauthResponseForLog(error.paypalData) };
      res.status(status).json(body);
    }
  };
}

// Health check — confirma que el servidor responde.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Devuelve las credenciales actuales del .env para pre-cargar el panel CREDS de la UI.
app.get('/api/credentials', (_req, res) => {
  res.json(readCredentialsFromFile());
});

// Guarda nuevas credenciales en el .env, las aplica en memoria e invalida el cache de tokens.
app.post('/api/credentials', (req, res) => {
  const { sandbox, live } = req.body || {};
  if (!sandbox || !live || typeof sandbox !== 'object' || typeof live !== 'object') {
    res.status(400).json({ error: 'Both sandbox and live credentials are required' });
    return;
  }

  const parsed = readEnvFile();
  parsed.SANDBOX_CLIENT_ID = String(sandbox.clientId || '').trim();
  parsed.SANDBOX_CLIENT_SECRET = String(sandbox.clientSecret || '').trim();
  parsed.SANDBOX_MERCHANT_ID = String(sandbox.merchantId || '').trim();
  parsed.SANDBOX_API_BASE = parsed.SANDBOX_API_BASE || DEFAULT_API_BASE.sandbox;
  parsed.LIVE_CLIENT_ID = String(live.clientId || '').trim();
  parsed.LIVE_CLIENT_SECRET = String(live.clientSecret || '').trim();
  parsed.LIVE_MERCHANT_ID = String(live.merchantId || '').trim();
  parsed.LIVE_API_BASE = parsed.LIVE_API_BASE || DEFAULT_API_BASE.live;
  parsed.PORT = parsed.PORT || process.env.PORT || '3000';
  parsed.CUSTOMER_ID = String(req.body.customerId || '').trim() || DEFAULT_CUSTOMER_ID;

  try {
    writeEnvFile(parsed);
    applyEnvValues(parsed);
    tokenCache.sandbox = null;
    tokenCache.live = null;
    res.json({ ok: true, message: 'Credentials saved to .env' });
  } catch (error) {
    res.status(500).json({ error: `Could not write .env: ${error.message}` });
  }
});

// Inicializa el SDK: obtiene OAuth, devuelve clientId + idToken al frontend.
// El idToken va en data-sdk-client-token del SDK JS; el access_token NUNCA se expone.
app.get('/api/sdk-init', asyncRoute(async (req, res) => {
  const env = normalizeEnv(req.query.env);
  const c = cfg(env);
  const { idToken, paypalResponse } = await getAccessToken(env);

  res.json({
    idToken,
    clientId: c.clientId,
    merchantId: c.merchantId,
    customerId: c.customerId,
    apiBase: c.apiBase,
    env,
    _log: {
      response: oauthResponseForLog(paypalResponse)
    }
  });
}));

// Proxy de Create Order → POST /v2/checkout/orders.
// Inyecta PayPal-Request-Id (idempotencia) y PayPal-Client-Metadata-Id (correlación con Fraudnet/STC).
app.post('/api/orders', asyncRoute(async (req, res) => {
  const { env, payload, cmid, requestId, mockResponse } = req.body;
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'payload is required' });
    return;
  }
  if (!validateCmid(cmid)) {
    res.status(400).json({ error: 'Valid cmid is required' });
    return;
  }

  const c = cfg(env);
  const { accessToken } = await getAccessToken(env);
  const result = await paypalFetch(`${c.apiBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: bearerHeaders(accessToken, {
      'PayPal-Request-Id': paypalRequestId(requestId),
      'PayPal-Client-Metadata-Id': cmid,
      ...mockHeader(mockResponse)
    }),
    body: JSON.stringify(payload)
  });
  sendPayPal(res, result);
}));

// Proxy de Get Order → GET /v2/checkout/orders/:id.
// Se usa tras crear una orden con token (tarjeta guardada) para verificar si ya se capturó.
app.get('/api/orders/:id', asyncRoute(async (req, res) => {
  const c = cfg(req.query.env);
  const { accessToken } = await getAccessToken(c.env);
  const result = await paypalFetch(`${c.apiBase}/v2/checkout/orders/${encodeURIComponent(req.params.id)}`, {
    method: 'GET',
    headers: bearerHeaders(accessToken)
  });
  sendPayPal(res, result);
}));

// Proxy de Capture Order → POST /v2/checkout/orders/:id/capture.
// Solo debe llamarse desde onApprove cuando liabilityShift es undefined o "POSSIBLE".
app.post('/api/orders/:id/capture', asyncRoute(async (req, res) => {
  const { env, cmid, requestId, mockResponse } = req.body;
  if (!validateCmid(cmid)) {
    res.status(400).json({ error: 'Valid cmid is required' });
    return;
  }

  const c = cfg(env);
  const { accessToken } = await getAccessToken(c.env);
  const result = await paypalFetch(`${c.apiBase}/v2/checkout/orders/${encodeURIComponent(req.params.id)}/capture`, {
    method: 'POST',
    headers: bearerHeaders(accessToken, {
      'PayPal-Request-Id': paypalRequestId(requestId),
      'PayPal-Client-Metadata-Id': cmid,
      ...mockHeader(mockResponse)
    }),
    body: JSON.stringify({})
  });
  sendPayPal(res, result);
}));

// Proxy de Set Transaction Context → PUT /v1/risk/transaction-contexts/:merchantId/:cmid.
// No bloqueante: errores se loguean pero no deben detener el checkout.
app.put('/api/stc', asyncRoute(async (req, res) => {
  const { env, cmid, additionalData } = req.body;
  if (!validateCmid(cmid)) {
    res.status(400).json({ error: 'Valid cmid is required' });
    return;
  }

  const c = cfg(env);
  const { accessToken } = await getAccessToken(c.env);
  const result = await paypalFetch(
    `${c.apiBase}/v1/risk/transaction-contexts/${encodeURIComponent(c.merchantId)}/${encodeURIComponent(cmid)}`,
    {
      method: 'PUT',
      headers: bearerHeaders(accessToken),
      body: JSON.stringify({ additional_data: Array.isArray(additionalData) ? additionalData : [] })
    }
  );
  sendPayPal(res, result);
}));

// Proxy de lista de tokens → GET /v3/vault/payment-tokens?customer_id=...
// Devuelve las tarjetas guardadas del comprador identificado por customerId.
app.get('/api/vault/payment-tokens', asyncRoute(async (req, res) => {
  const { env, customerId } = req.query;
  if (!customerId) {
    res.status(400).json({ error: 'customerId is required' });
    return;
  }

  const c = cfg(env);
  const { accessToken } = await getAccessToken(c.env);
  const result = await paypalFetch(
    `${c.apiBase}/v3/vault/payment-tokens?customer_id=${encodeURIComponent(customerId)}`,
    { method: 'GET', headers: bearerHeaders(accessToken) }
  );
  sendPayPal(res, result);
}));

// Proxy de eliminación de token → DELETE /v3/vault/payment-tokens/:id.
app.delete('/api/vault/payment-tokens/:id', asyncRoute(async (req, res) => {
  const c = cfg(req.query.env);
  const { accessToken } = await getAccessToken(c.env);
  const result = await paypalFetch(
    `${c.apiBase}/v3/vault/payment-tokens/${encodeURIComponent(req.params.id)}`,
    { method: 'DELETE', headers: bearerHeaders(accessToken) }
  );
  sendPayPal(res, result);
}));

// Proxy de opciones de financiamiento → POST /v1/credit/calculated-financing-options.
// Se usa para tarjetas guardadas (token); para tarjeta nueva el SDK llama onInstallmentsAvailable.
// El payload debe incluir flow_context.attributes: ["FEE_POLICY_CHARGE_CONSUMER"] para obtener IC2B/MCI.
app.post('/api/financing-options', asyncRoute(async (req, res) => {
  const { env, payload } = req.body;
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'payload is required' });
    return;
  }

  const c = cfg(env);
  const { accessToken } = await getAccessToken(c.env);
  const result = await paypalFetch(`${c.apiBase}/v1/credit/calculated-financing-options`, {
    method: 'POST',
    headers: bearerHeaders(accessToken),
    body: JSON.stringify(payload)
  });
  sendPayPal(res, result);
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ACDC demo server-side -> http://localhost:${PORT}`);
});
