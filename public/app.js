    /* ============================================================
       Configuración
       ============================================================ */

    const DEFAULT_CUSTOMER_ID = 'testcustomer-2026';
    const CURRENCY = 'MXN';

    // Fraudnet: 2–4 letras del nombre corto del merchant. Forma parte del
    // identificador "s" enviado a PayPal Risk: <SHORT>_<MERCHANT_ID>_ACDC.
    const MERCHANT_SHORT_NAME = 'ACDCDEMO';
    const FRAUDNET_PRODUCT = 'ACDC';
    const FRAUDNET_FNCLS = 'fnparams-dede7cc5-15fd-4c75-a9f4-36c430ee3a99';
    const FRAUDNET_LIB_URL = 'https://c.paypal.com/da/r/fb.js';
    const FRAUDNET_CONFIG_SCRIPT_ID = 'paypal-fraudnet-config';
    const FRAUDNET_LIB_SCRIPT_ID = 'paypal-fraudnet-lib';
    // Datos demo del comprador para el payload de Create Order.
    // En producción estos valores deben venir del perfil del usuario autenticado.
    const BUYER = {
      email_address: 'jdoe@paypal.com',
      phone_number: { national_number: '5546723845' },
      name: { given_name: 'John', surname: 'Doe' },
      address: {
        address_line_1: 'Mariano Escobedo 476',
        address_line_2: 'Col Anzures',
        admin_area_2: 'Miguel Hidalgo',
        admin_area_1: 'CMX',
        postal_code: '11590',
        country_code: 'MX'
      }
    };

    /* ============================================================
       Estado
       ============================================================ */

    // Estado global de la sesión de checkout.
    // cmid y fraudnetCmid se generan una sola vez por sesión y se reutilizan en reintentos.
    // sdkLoadGeneration evita callbacks de generaciones anteriores del SDK al reinicializarlo.
    const state = {
      sdkConfig: null,         // Respuesta del último /api/sdk-init
      envConfigs: {},          // Cache de configs por entorno (sandbox/live)
      cmid: '',                // CMID actual de la sesión (32 chars alfanuméricos, sin guiones)
      fraudnetCmid: '',        // CMID con el que se cargó Fraudnet (evita recargas innecesarias)
      cardField: null,         // Instancia de paypal.CardFields activa
      savedCards: [],          // Tokens de Vault del comprador
      selectedCardToken: '',   // Token seleccionado para cobrar con tarjeta guardada
      selectedInstallment: null, // Plan de MSI o IC2B/MCI seleccionado por el comprador
      currentRequestId: '',    // PayPal-Request-Id de la transacción en curso (idempotencia)
      sdkScriptId: 'paypal-sdk-script',
      sdkLoadGeneration: 0,    // Contador que invalida callbacks de cargas anteriores del SDK
      customerId: DEFAULT_CUSTOMER_ID, // customer.id estable del comprador para Vault
      isResetting: false       // Flag para evitar reinicializaciones concurrentes
    };

    /* ============================================================
       Utilidades
       ============================================================ */

    const $ = (selector) => document.querySelector(selector);

    function getEnvName() {
      const checked = document.querySelector('input[name="paypal-env"]:checked');
      return checked && checked.value === 'live' ? 'live' : 'sandbox';
    }

    function getEnvConfig() {
      const env = getEnvName();
      return state.envConfigs[env] || {
        label: env === 'live' ? 'Live' : 'Sandbox',
        apiBase: env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
        clientId: '',
        merchantId: ''
      };
    }

    function getCustomerId() {
      return state.customerId || DEFAULT_CUSTOMER_ID;
    }

    function getThreeDsMode() {
      const checked = document.querySelector('input[name="three-ds-mode"]:checked');
      return checked && checked.value === 'merchant' ? 'merchant' : 'risk';
    }

    function getNegativeTestMode() {
      const checked = document.querySelector('input[name="neg-test"]:checked');
      const v = checked && checked.value;
      return v === 'INSTRUMENT_DECLINED' || v === 'TRANSACTION_REFUSED' ? v : 'none';
    }

    // Devuelve el header PayPal-Mock-Response para simular declines en Sandbox.
    // Con "none" devuelve un objeto vacío (sin mock). Solo disponible en Sandbox.
    function negativeTestHeaders() {
      const mode = getNegativeTestMode();
      return mode === 'none'
        ? {}
        : { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: mode }) };
    }

    function getAmount() {
      const raw = Number($('#amount').value);
      return Number.isFinite(raw) && raw > 0 ? raw.toFixed(2) : '1.00';
    }

    function formatMoney(value, currencyCode = CURRENCY) {
      const n = Number(value);
      const formatted = Number.isFinite(n)
        ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(value || '0.00');
      return `$${formatted} ${currencyCode}`;
    }

    function showNotification(message, type = 'info') {
      const node = $('#notification');
      node.textContent = message;
      node.className = `notice ${type} show`;
    }

    function hideNotification() {
      $('#notification').className = 'notice';
      $('#notification').textContent = '';
    }

    function setLoading(isLoading) {
      $('#loader').classList.toggle('show', isLoading);
      $('#card-field-submit-button').disabled = isLoading;
      $('#saved-card-pay-button').disabled = isLoading;
      $('#card-field-submit-button').textContent = isLoading ? 'Processing...' : 'Pay now with card';
      $('#saved-card-pay-button').textContent = isLoading ? 'Processing...' : 'Pay with saved card';
    }

    // Genera el CMID de sesión: UUID v4 sin guiones (32 chars hex).
    // Fallback para navegadores sin Web Crypto API.
    function generateCMID() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
      return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }

    // Genera un UUID para PayPal-Request-Id (idempotencia de Create Order y Capture).
    // El mismo UUID debe reutilizarse en reintentos de la misma transacción.
    function generateRequestId() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    // Inicia una nueva transacción generando un requestId fresco y guardándolo en el estado.
    function startTransactionRequest() {
      state.currentRequestId = generateRequestId();
      return state.currentRequestId;
    }

    /* ============================================================
       Fraudnet
       ------------------------------------------------------------
       Inyecta los dos <script> de Fraudnet (config JSON + fb.js)
       una sola vez por sesión de checkout. La función es idempotente
       respecto al CMID: si el CMID no cambia, no recarga. Cuando se
       inicia una transacción nueva (resetFlow regenera el CMID), se
       reemplazan los scripts para mantener la sesión de Fraudnet
       sincronizada con el nuevo CMID.
       ============================================================ */
    function loadFraudnet(cmid) {
      if (!cmid) return;
      if (state.fraudnetCmid === cmid) return;

      const cfg = getEnvConfig();
      if (!cfg || !cfg.merchantId) return;

      const oldConfig = document.getElementById(FRAUDNET_CONFIG_SCRIPT_ID);
      if (oldConfig) oldConfig.remove();
      const oldLib = document.getElementById(FRAUDNET_LIB_SCRIPT_ID);
      if (oldLib) oldLib.remove();

      const sValue = `${MERCHANT_SHORT_NAME}_${cfg.merchantId}_${FRAUDNET_PRODUCT}`;

      const configScript = document.createElement('script');
      configScript.id = FRAUDNET_CONFIG_SCRIPT_ID;
      configScript.type = 'application/json';
      configScript.setAttribute('fncls', FRAUDNET_FNCLS);
      configScript.textContent = JSON.stringify({ f: cmid, s: sValue });
      document.body.appendChild(configScript);

      const libScript = document.createElement('script');
      libScript.id = FRAUDNET_LIB_SCRIPT_ID;
      libScript.type = 'text/javascript';
      libScript.src = FRAUDNET_LIB_URL;
      libScript.async = true;
      document.body.appendChild(libScript);

      state.fraudnetCmid = cmid;

      addLog({
        method: 'SCRIPT',
        endpoint: FRAUDNET_LIB_URL,
        request: { fncls: FRAUDNET_FNCLS, body: { f: cmid, s: sValue } },
        response: { injected: [FRAUDNET_CONFIG_SCRIPT_ID, FRAUDNET_LIB_SCRIPT_ID] },
        status: 'OK'
      });
    }

    function safeParseJson(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) { return text; }
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Escape solo &, <, > — NO las comillas. El regex de highlight necesita
    // ver las " reales para detectar strings; las comillas dentro del <pre>
    // no representan riesgo XSS porque no estamos en un atributo HTML.
    function escapeHtmlForJson(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function syntaxHighlightJson(value) {
      const json = typeof value === 'string'
        ? value
        : JSON.stringify(value ?? {}, null, 2);
      // Regex groups: quoted strings (keys end with ":"), booleans, null, numbers
      return escapeHtmlForJson(json).replace(
        /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
          let cls = 'json-number';
          if (/^"/.test(match)) cls = /:\s*$/.test(match) ? 'json-key' : 'json-string';
          else if (/^(?:true|false)$/.test(match)) cls = 'json-boolean';
          else if (/^null$/.test(match)) cls = 'json-null';
          return `<span class="${cls}">${match}</span>`;
        }
      );
    }

    // Enmascara credenciales sensibles antes de mostrarlas en el panel de logs.
    // Campos de autorización → "[redacted]"; access_token → primeros 5 chars + "*".
    function maskSecrets(input) {
      if (!input || typeof input !== 'object') return input;
      const clone = JSON.parse(JSON.stringify(input));
      const redactKeys = ['Authorization', 'authorization', 'clientSecret', 'client_secret', 'id_token', 'idToken'];
      const partialMaskKeys = ['access_token', 'accessToken'];
      const maskToken = (value) => {
        if (typeof value !== 'string') return value;
        return `${value.slice(0, 5)}${'*'.repeat(Math.max(value.length - 5, 0))}`;
      };
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        Object.keys(obj).forEach((key) => {
          if (redactKeys.includes(key)) obj[key] = '[redacted]';
          else if (partialMaskKeys.includes(key)) obj[key] = maskToken(obj[key]);
          else walk(obj[key]);
        });
      };
      walk(clone);
      return clone;
    }

    function updateEnvHint() {
      document.getElementById('env-bar').classList.toggle('is-live', getEnvName() === 'live');
    }

    /* ============================================================
       API logging — entradas colapsables, request/response apilados
       ============================================================ */

    function methodClass(method) {
      const m = String(method || '').toLowerCase();
      if (m === '3ds') return 'threeds';
      if (m === 'sdk') return 'sdk';
      return ['get', 'post', 'put', 'delete'].includes(m) ? m : '';
    }

    function addLog({ method, endpoint, request, response, status, error }) {
      const stream = $('#log-stream');
      const empty = stream.querySelector('.empty-logs');
      if (empty) empty.remove();

      const code = status || (error ? 'ERR' : '...');
      let statusClass = 'pending';
      if (typeof status === 'number') {
        statusClass = `s${String(status)[0]}`;
      } else if (status === 'PASS' || status === 'OK') {
        statusClass = 's2';
      } else if (status === 'BLOCKED' || status === 'WARN') {
        statusClass = 'warn';
      } else if (status === 'ERROR' || status === 'FAIL') {
        statusClass = 's4';
      }
      const ts = new Date().toLocaleTimeString('en-US');

      const entry = document.createElement('article');
      entry.className = 'log-entry';
      entry.innerHTML = `
        <div class="log-head" role="button" tabindex="0" aria-expanded="false">
          <span class="toggle-arrow" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="method ${methodClass(method)}">${escapeHtml(method)}</span>
          <span class="endpoint" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</span>
          <span class="status ${statusClass}">${escapeHtml(code)}</span>
          <button class="log-copy" type="button" title="Copy log entry" aria-label="Copy log entry">
            <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path fill="currentColor" d="M10 1H4a2 2 0 0 0-2 2v8h2V3h6V1zm3 3H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 10H7V6h6v8z"/>
            </svg>
          </button>
        </div>
        <div class="log-body">
          <div class="log-section">
            <h4>Request <span class="ts">${ts}</span></h4>
            <div class="log-url"><span class="log-url-method ${methodClass(method)}">${escapeHtml(method)}</span><span class="log-url-text">${escapeHtml(endpoint)}</span></div>
            <pre>${syntaxHighlightJson(maskSecrets(request))}</pre>
          </div>
          <div class="log-section">
            <h4>${error ? 'Error' : 'Response'}</h4>
            <pre>${syntaxHighlightJson(error ? { message: error.message || String(error) } : maskSecrets(response))}</pre>
          </div>
        </div>
      `;

      const head = entry.querySelector('.log-head');
      const toggleOpen = () => {
        const isOpen = entry.classList.toggle('is-open');
        head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      };
      head.addEventListener('click', toggleOpen);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleOpen();
        }
      });

      const copyBtn = entry.querySelector('.log-copy');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = formatLogForCopy({ method, endpoint, status: code, request, response, error, ts });
        const onDone = () => {
          copyBtn.classList.add('copied');
          setTimeout(() => copyBtn.classList.remove('copied'), 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onDone).catch((err) => {
            console.warn('Copy failed:', err);
          });
        } else {
          // Fallback para entornos sin Clipboard API (p.ej. file:// estricto)
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); onDone(); } catch (_) {}
          ta.remove();
        }
      });

      stream.appendChild(entry);
      stream.scrollTop = stream.scrollHeight;
    }

    function formatLogForCopy({ method, endpoint, status, request, response, error, ts }) {
      const lines = [];
      lines.push(`${method} ${endpoint}`);
      lines.push(`Status: ${status}`);
      lines.push(`Time: ${ts}`);
      lines.push('');
      lines.push('Request:');
      lines.push(JSON.stringify(maskSecrets(request), null, 2));
      lines.push('');
      if (error) {
        lines.push('Error:');
        lines.push(JSON.stringify({ message: error.message || String(error) }, null, 2));
      } else {
        lines.push('Response:');
        lines.push(JSON.stringify(maskSecrets(response), null, 2));
      }
      return lines.join('\n');
    }

    function clearLogs() {
      $('#log-stream').innerHTML = '<div class="empty-logs">PayPal API calls will appear here. Click each entry to expand request and response.</div>';
    }

    async function serverRequest({ method = 'GET', endpoint, body, logMethod = method, logEndpoint = endpoint, logRequest }) {
      const requestBody = body ?? null;
      let alreadyLogged = false;

      try {
        const response = await fetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(requestBody)
        });
        const text = await response.text();
        const data = safeParseJson(text);
        const logResponse = data && typeof data === 'object' && data._log && Object.prototype.hasOwnProperty.call(data._log, 'response')
          ? data._log.response
          : data;
        addLog({
          method: logMethod, endpoint: logEndpoint,
          request: logRequest || requestBody,
          response: logResponse,
          status: response.status
        });
        alreadyLogged = true;

        if (!response.ok) {
          const message = typeof data === 'object' && data && (data.message || data.error_description || data.error)
            ? (data.message || data.error_description || data.error)
            : `HTTP ${response.status}`;
          const err = new Error(message);
          err.response = data;
          err.status = response.status;
          throw err;
        }
        if (data && typeof data === 'object' && data._log) {
          const { _log, ...payload } = data;
          return payload;
        }
        return data;
      } catch (error) {
        // Solo logueamos desde aquí cuando la falla ocurrió antes de tener
        // la respuesta (network error, CORS, parse). Si ya logueamos la
        // respuesta HTTP (incluyendo 4xx/5xx) no creamos un duplicado.
        if (!alreadyLogged) {
          addLog({
            method: logMethod, endpoint: logEndpoint,
            request: logRequest || requestBody,
            error
          });
        }
        throw error;
      }
    }

    async function getSdkInit({ force = false } = {}) {
      const env = getEnvName();
      if (!force && state.sdkConfig && state.sdkConfig.env === env) return state.sdkConfig;
      const cfg = getEnvConfig();

      const data = await serverRequest({
        method: 'GET',
        endpoint: `/api/sdk-init?env=${encodeURIComponent(env)}`,
        logMethod: 'POST',
        logEndpoint: `${cfg.apiBase}/v1/oauth2/token`,
        logRequest: {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: '[redacted basic auth]'
          },
          body: 'grant_type=client_credentials&response_type=id_token'
        }
      });

      if (!data.clientId || !data.idToken) {
        throw new Error('Server did not return clientId/idToken for the PayPal SDK.');
      }

      state.envConfigs[env] = {
        label: env === 'live' ? 'Live' : 'Sandbox',
        clientId: data.clientId,
        merchantId: data.merchantId,
        apiBase: data.apiBase
      };
      state.customerId = data.customerId || DEFAULT_CUSTOMER_ID;
      state.sdkConfig = { env, ...state.envConfigs[env], idToken: data.idToken };
      return state.sdkConfig;
    }

    function readMockResponse(headers = {}) {
      const raw = headers['PayPal-Mock-Response'] || headers['paypal-mock-response'];
      if (!raw) return '';
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed.mock_application_codes || '';
      } catch (_) {
        return String(raw);
      }
    }

    function encodeQuery(params) {
      return new URLSearchParams(params).toString();
    }

    function basePayPalHeaders(extra = {}) {
      return {
        Authorization: '[redacted bearer token]',
        'Content-Type': 'application/json',
        ...extra
      };
    }

    function requestHeadersWithRisk(mockResponse = '') {
      const headers = basePayPalHeaders({
        'PayPal-Client-Metadata-Id': state.cmid,
        'PayPal-Request-Id': state.currentRequestId
      });
      if (mockResponse) {
        headers['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: mockResponse });
      }
      return headers;
    }

    // SDK callback — routes PayPal REST calls through our backend proxy (/api/*).
    // The SDK passes raw PayPal API paths; we map them to our Express endpoints,
    // attach CMID/requestId correlation, and forward mock-response headers for testing.
    async function paypalRequest(path, options = {}) {
      const cfg = getEnvConfig();
      const env = getEnvName();
      const method = (options.method || 'GET').toUpperCase();
      const requestBody = options.body ? safeParseJson(options.body) : null;
      const mockResponse = readMockResponse(options.headers || {});
      const baseLog = `${cfg.apiBase}${path}`;

      if (method === 'POST' && path === '/v2/checkout/orders') {
        const body = {
          env,
          payload: requestBody,
          cmid: state.cmid,
          requestId: state.currentRequestId,
          mockResponse
        };
        return serverRequest({
          method,
          endpoint: '/api/orders',
          body,
          logEndpoint: baseLog,
          logRequest: {
            headers: requestHeadersWithRisk(mockResponse),
            body: requestBody
          }
        });
      }

      const captureMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
      if (method === 'POST' && captureMatch) {
        const orderId = decodeURIComponent(captureMatch[1]);
        const body = {
          env,
          cmid: state.cmid,
          requestId: state.currentRequestId,
          mockResponse
        };
        return serverRequest({
          method,
          endpoint: `/api/orders/${encodeURIComponent(orderId)}/capture`,
          body,
          logEndpoint: baseLog,
          logRequest: {
            headers: requestHeadersWithRisk(mockResponse),
            body: {}
          }
        });
      }

      const orderMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
      if (method === 'GET' && orderMatch) {
        const orderId = decodeURIComponent(orderMatch[1]);
        return serverRequest({
          method,
          endpoint: `/api/orders/${encodeURIComponent(orderId)}?${encodeQuery({ env })}`,
          logEndpoint: baseLog,
          logRequest: {
            headers: basePayPalHeaders(),
            body: null
          }
        });
      }

      if (method === 'PUT' && path.startsWith('/v1/risk/transaction-contexts/')) {
        const body = {
          env,
          cmid: state.cmid,
          additionalData: requestBody?.additional_data || []
        };
        return serverRequest({
          method,
          endpoint: '/api/stc',
          body,
          logEndpoint: baseLog,
          logRequest: {
            headers: basePayPalHeaders(),
            body: { additional_data: body.additionalData }
          }
        });
      }

      if (method === 'POST' && path === '/v1/credit/calculated-financing-options') {
        const body = { env, payload: requestBody };
        return serverRequest({
          method,
          endpoint: '/api/financing-options',
          body,
          logEndpoint: baseLog,
          logRequest: {
            headers: basePayPalHeaders(),
            body: requestBody
          }
        });
      }

      if (method === 'GET' && path.startsWith('/v3/vault/payment-tokens?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        const customerId = query.get('customer_id') || getCustomerId();
        return serverRequest({
          method,
          endpoint: `/api/vault/payment-tokens?${encodeQuery({ env, customerId })}`,
          logEndpoint: baseLog,
          logRequest: {
            headers: basePayPalHeaders(),
            body: null
          }
        });
      }

      const vaultDeleteMatch = path.match(/^\/v3\/vault\/payment-tokens\/([^/]+)$/);
      if (method === 'DELETE' && vaultDeleteMatch) {
        const tokenId = decodeURIComponent(vaultDeleteMatch[1]);
        return serverRequest({
          method,
          endpoint: `/api/vault/payment-tokens/${encodeURIComponent(tokenId)}?${encodeQuery({ env })}`,
          body: { env },
          logEndpoint: baseLog,
          logRequest: {
            headers: basePayPalHeaders(),
            body: null
          }
        });
      }

      throw new Error(`No server-side route is mapped for ${method} ${path}`);
    }

    /* ============================================================
       CREDS modal
       ============================================================ */

    async function openCredsModal() {
      const modal = $('#creds-modal');
      const status = $('#creds-status');
      status.textContent = '';
      status.className = 'creds-status';

      try {
        const response = await fetch('/api/credentials');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

        $('#cred-sandbox-client-id').value = data.sandbox?.clientId || '';
        $('#cred-sandbox-client-secret').value = data.sandbox?.clientSecret || '';
        $('#cred-sandbox-merchant-id').value = data.sandbox?.merchantId || '';
        $('#cred-live-client-id').value = data.live?.clientId || '';
        $('#cred-live-client-secret').value = data.live?.clientSecret || '';
        $('#cred-live-merchant-id').value = data.live?.merchantId || '';
        $('#cred-customer-id').value = data.customerId || DEFAULT_CUSTOMER_ID;
      } catch (error) {
        status.textContent = `Could not load credentials: ${error.message}`;
        status.className = 'creds-status error';
      }

      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      setTimeout(() => $('#cred-sandbox-client-id').focus(), 50);
    }

    function closeCredsModal() {
      $('#creds-modal').hidden = true;
      document.body.style.overflow = '';
    }

    async function saveCreds() {
      const status = $('#creds-status');
      const saveButton = $('#creds-save');
      status.textContent = 'Saving...';
      status.className = 'creds-status';
      saveButton.disabled = true;

      const payload = {
        sandbox: {
          clientId: $('#cred-sandbox-client-id').value.trim(),
          clientSecret: $('#cred-sandbox-client-secret').value.trim(),
          merchantId: $('#cred-sandbox-merchant-id').value.trim()
        },
        live: {
          clientId: $('#cred-live-client-id').value.trim(),
          clientSecret: $('#cred-live-client-secret').value.trim(),
          merchantId: $('#cred-live-merchant-id').value.trim()
        },
        customerId: $('#cred-customer-id').value.trim()
      };

      try {
        const response = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

        status.textContent = 'Saved. Reloading...';
        status.className = 'creds-status success';
        setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        status.textContent = `Could not save: ${error.message}`;
        status.className = 'creds-status error';
        saveButton.disabled = false;
      }
    }

    function setupCredsModal() {
      $('#creds-button').addEventListener('click', openCredsModal);
      $('#creds-close').addEventListener('click', closeCredsModal);
      $('#creds-cancel').addEventListener('click', closeCredsModal);
      $('#creds-save').addEventListener('click', saveCreds);

      $('#creds-modal').addEventListener('click', (event) => {
        if (event.target.id === 'creds-modal') closeCredsModal();
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !$('#creds-modal').hidden) closeCredsModal();
      });

      document.querySelectorAll('.cred-eye').forEach((button) => {
        button.addEventListener('click', () => {
          const target = document.getElementById(button.dataset.target);
          if (!target) return;
          target.type = target.type === 'password' ? 'text' : 'password';
        });
      });
    }

    /* ============================================================
       PayPal payloads
       ============================================================ */

    function buildBaseOrderPayload() {
      const amount = getAmount();
      return {
        intent: 'CAPTURE',
        application_context: { shipping_preference: 'SET_PROVIDED_ADDRESS' },
        payer: BUYER,
        purchase_units: [{
          amount: {
            value: amount,
            currency_code: CURRENCY,
            breakdown: {
              item_total: { value: amount, currency_code: CURRENCY },
              discount: { value: '0.00', currency_code: CURRENCY },
              shipping: { value: '0.00', currency_code: CURRENCY }
            }
          },
          items: [{
            name: 'Sofa Deluxe para Dos Personas',
            description: 'Sofa de diseno premium',
            sku: 'sku01',
            unit_amount: { currency_code: CURRENCY, value: amount },
            quantity: '1',
            category: 'PHYSICAL_GOODS'
          }],
          shipping: {
            name: { full_name: 'John Doe' },
            address: {
              address_line_1: 'Mariano Escobedo 476',
              address_line_2: 'piso 14',
              admin_area_2: 'Miguel Hidalgo',
              admin_area_1: 'CMX',
              postal_code: '11590',
              country_code: 'MX'
            }
          }
        }]
      };
    }

    function buildNewCardOrderPayload() {
      const payload = buildBaseOrderPayload();
      const cardAttributes = {};

      if ($('#vault').checked) {
        cardAttributes.customer = { id: getCustomerId() };
        cardAttributes.vault = {
          store_in_vault: 'ON_SUCCESS',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: true
        };
      }

      if (getThreeDsMode() === 'merchant') {
        cardAttributes.verification = { method: 'SCA_ALWAYS' };
      }

      if (Object.keys(cardAttributes).length > 0 || getThreeDsMode() === 'merchant') {
        payload.payment_source = {
          card: { attributes: cardAttributes }
        };
      }

      return payload;
    }

    function buildSavedCardOrderPayload(tokenId, installment) {
      const payload = buildBaseOrderPayload();
      const tokenSource = { id: tokenId, type: 'PAYMENT_METHOD_TOKEN' };

      if (installment && installment.term > 1) {
        tokenSource.attributes = {
          installments: {
            term: installment.term,
            interval_duration: installment.interval_duration,
            fee_reference_id: installment.fee_reference_id
          }
        };
      }
      payload.payment_source = { token: tokenSource };
      return payload;
    }

    async function createOrderForNewCard() {
      if (!state.currentRequestId) startTransactionRequest();
      await callSTC();
      const payload = buildNewCardOrderPayload();
      const data = await paypalRequest('/v2/checkout/orders', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (!data.id) throw new Error('PayPal did not return an order ID.');
      return data.id;
    }

    // applyNegativeTest: solo aplicarlo en el flujo de tarjeta nueva (capture
     // es el step donde simulamos el decline). En tarjeta recordada el negative
     // testing va en createOrder (single step capture), no aquí.
    async function captureOrder(orderId, { applyNegativeTest = false } = {}) {
      const negHeaders = applyNegativeTest ? negativeTestHeaders() : {};
      return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: negHeaders,
        body: JSON.stringify({})
      });
    }

    async function getOrder(orderId) {
      return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: 'GET'
      });
    }

    async function callSTC() {
      const cfg = getEnvConfig();
      if (!cfg.merchantId || !state.cmid) return null;
      const body = {
        additional_data: [
          { key: 'sender_account_id', value: '518ec6feed47eb04601be72bec147d96' },
          { key: 'sender_first_name', value: 'JHON' },
          { key: 'sender_last_name', value: 'DOE DOE' },
          { key: 'sender_email', value: 'jdoe@paypal.com' },
          { key: 'sender_phone', value: '9511688216' },
          { key: 'sender_country_code', value: 'MX' },
          { key: 'sender_create_date', value: '2020-12-10T13:52:19-06:00' },
          { key: 'highrisk_txn_flag', value: '0' },
          { key: 'vertical', value: 'Retail' },
          { key: 'cd_string_one', value: '1' },
          { key: 'cd_string_two', value: 'Playera Nike etc' }
        ]
      };
      try {
        return await paypalRequest(`/v1/risk/transaction-contexts/${encodeURIComponent(cfg.merchantId)}/${encodeURIComponent(state.cmid)}`, {
          method: 'PUT',
          body: JSON.stringify(body)
        });
      } catch (error) {
        console.warn('Non-blocking STC failed:', error);
        return null;
      }
    }

    /* ============================================================
       3DS
       ============================================================ */

    function readLiabilityShift(order, approveData) {
      return (
        order?.payment_source?.card?.authentication_result?.liability_shift ||
        order?.payment_source?.card?.authentication_result?.three_d_secure?.liability_shift ||
        approveData?.liabilityShift ||
        null
      );
    }

    async function validate3dsAndCapture(orderId, approveData = {}) {
      const order = await getOrder(orderId);
      const liabilityShift = readLiabilityShift(order, approveData);

      if (liabilityShift && liabilityShift !== 'POSSIBLE') {
        addLog({
          method: '3DS',
          endpoint: 'onApprove',
          request: { orderId, mode: getThreeDsMode() },
          response: { liabilityShift, captured: false },
          status: 'BLOCKED'
        });
        throw new Error(`3DS validation failed. liability_shift=${liabilityShift}`);
      }

      addLog({
        method: '3DS',
        endpoint: 'onApprove',
        request: { orderId, mode: getThreeDsMode() },
        response: { liabilityShift: liabilityShift || 'NOT_PRESENT', captured: true },
        status: 'PASS'
      });

      return captureOrder(orderId, { applyNegativeTest: true });
    }

    /* ============================================================
       Installments / IC2B
       ============================================================ */

    // Extracts the qualifying MSI/IC2B options from the financing_options array.
    // Only CARD_ISSUER_INSTALLMENTS plans are shown; other products (e.g. BNPL) are ignored.
    function normalizeFinancingOptions(financingOptions) {
      return (financingOptions || [])
        .filter((option) => option.product === 'CARD_ISSUER_INSTALLMENTS')
        .flatMap((option) => option.qualifying_financing_options || []);
    }

    // Serializes a financing option into the value stored on the <select> element.
    // Includes all fields needed at submit time: term, interval_duration (REST snake_case),
    // fee_reference_id (required for IC2B / Meses Con Intereses), and display fields.
    function makeInstallmentValue(option) {
      const fee = Number(option.total_consumer_fee?.value || 0);
      return JSON.stringify({
        term: option.credit_financing?.term || 1,
        interval_duration: option.credit_financing?.interval_duration || 'P1M',
        fee_reference_id: option.fee_reference_id || '',
        monthly_payment: option.monthly_payment?.value || getAmount(),
        currency_code: option.monthly_payment?.currency_code || CURRENCY,
        total_consumer_fee: fee
      });
    }

    // Builds the human-readable label for each financing plan shown in the UI.
    // MSI (Meses Sin Intereses): fee === 0 → merchant absorbs cost, label shows "interest-free".
    // IC2B / MCI (Meses Con Intereses): fee > 0 → buyer pays extra, label shows the fee amount.
    function installmentLabel(option) {
      const term = Number(option.credit_financing?.term || 1);
      const monthly = option.monthly_payment?.value || getAmount();
      const currency = option.monthly_payment?.currency_code || CURRENCY;
      const fee = Number(option.total_consumer_fee?.value || 0);

      if (term <= 1) return `${formatMoney(monthly, currency)} · Single payment`;
      if (fee === 0) return `${formatMoney(monthly, currency)} x ${term} months interest-free`; // MSI
      return `${formatMoney(monthly, currency)} x ${term} months · IC2B fee ${formatMoney(fee, currency)}`; // IC2B / MCI
    }

    function populateInstallmentsSelect(select, financingOptions) {
      const options = normalizeFinancingOptions(financingOptions);
      select.innerHTML = '';

      const single = document.createElement('option');
      single.value = '';
      single.textContent = 'Single payment';
      select.appendChild(single);

      const realOptions = options.filter((option) => Number(option.credit_financing?.term || 1) > 1);
      if (!realOptions.length) {
        select.disabled = false;
        updatePaymentSummary(null);
        return;
      }

      realOptions.forEach((option) => {
        const node = document.createElement('option');
        node.value = makeInstallmentValue(option);
        node.textContent = installmentLabel(option);
        select.appendChild(node);
      });
      select.disabled = false;
      updatePaymentSummary(null);
    }

    function readInstallmentFromSelect(select) {
      if (!select.value) return null;
      try { return JSON.parse(select.value); } catch (_) { return null; }
    }

    function updatePaymentSummary(installment) {
      const amount = Number(getAmount());
      const fee = Number(installment?.total_consumer_fee || 0);
      const total = amount + fee;
      $('#summary-plan').textContent = installment && installment.term > 1
        ? `${installment.term} months${fee > 0 ? ' · IC2B' : ' interest-free'}`
        : 'Single payment';
      $('#summary-fee').textContent = formatMoney(fee);
      $('#summary-total').textContent = formatMoney(total);
    }

    async function loadSavedCardFinancingOptions(tokenId) {
      const select = $('#saved-card-installments-select');
      select.disabled = true;
      select.innerHTML = '<option value="">Loading options...</option>';

      const data = await paypalRequest('/v1/credit/calculated-financing-options', {
        method: 'POST',
        body: JSON.stringify({
          financing_country_code: 'MX',
          flow_context: { attributes: ['FEE_POLICY_CHARGE_CONSUMER'] },
          transaction_amount: { value: getAmount(), currency_code: CURRENCY },
          funding_instrument: {
            type: 'TOKEN',
            token: { type: 'PAYMENT_METHOD_TOKEN', payment_method_token: tokenId }
          }
        })
      });
      populateInstallmentsSelect(select, data.financing_options || []);
    }

    /* ============================================================
       Vault — saved cards in ACDC style
       ============================================================ */

    function getCardLogo(brand) {
      const b = String(brand || '').toLowerCase();
      if (b === 'visa') return '<span class="brand-tag visa">VISA</span>';
      if (b === 'mastercard') return '<span class="brand-tag mastercard">MC</span>';
      if (b === 'maestro') return '<span class="brand-tag maestro"><span>maestro</span></span>';
      if (b === 'amex' || b === 'american_express' || b === 'american express') return '<span class="brand-tag amex">AMEX</span>';
      return `<span class="brand-tag" style="background:#444;width:auto;padding:0 8px;">${escapeHtml(brand || 'CARD')}</span>`;
    }

    async function getSavedCards() {
      try {
        const data = await paypalRequest(`/v3/vault/payment-tokens?customer_id=${encodeURIComponent(getCustomerId())}`, {
          method: 'GET'
        });
        state.savedCards = data.payment_tokens || [];
      } catch (error) {
        state.savedCards = [];
        console.warn('Could not load saved cards:', error);
      }
      renderSavedCards();
    }

    async function deleteSavedCard(tokenId) {
      if (!confirm('Delete this saved card from Vault?')) return;
      await paypalRequest(`/v3/vault/payment-tokens/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE'
      });
      state.savedCards = state.savedCards.filter((card) => card.id !== tokenId);
      renderSavedCards();
      showNotification('Card removed from Vault.', 'success');
    }

    function renderSavedCards() {
      const section = $('#saved-cards-section');
      const container = $('#saved-cards-container');
      container.innerHTML = '';

      if (!state.savedCards.length) {
        section.classList.remove('show');
        state.selectedCardToken = '';
        $('#card-form').style.display = 'grid';
        $('#saved-card-installments').classList.remove('show');
        $('#saved-card-pay-button').style.display = 'none';
        return;
      }

      section.classList.add('show');

      state.savedCards.forEach((card, index) => {
        const info = card.payment_source?.card || {};
        const brand = info.brand || 'CARD';
        const last = info.last_digits || '----';
        const item = document.createElement('div');
        item.className = 'saved-card-item';
        item.innerHTML = `
          <div class="saved-card-row">
            <div class="saved-card-left">
              <input type="radio" id="saved-card-${index}" name="payment-method" value="${escapeHtml(card.id)}">
              ${getCardLogo(brand)}
              <label for="saved-card-${index}">x-${escapeHtml(last)}</label>
            </div>
            <button class="delete-card" type="button" title="Delete card" aria-label="Delete card">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="currentColor" d="M9 3a1 1 0 0 0-1 1v1H4a1 1 0 1 0 0 2h1.07l.86 12.04A2 2 0 0 0 7.92 21h8.16a2 2 0 0 0 1.99-1.96L18.93 7H20a1 1 0 1 0 0-2h-4V4a1 1 0 0 0-1-1H9zm1 2h4v0H10zm-2.93 4h9.86l-.84 11.83a1 1 0 0 1-1 1.17H9.92a1 1 0 0 1-1-1.17L7.07 9zM10 11a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z"/>
              </svg>
            </button>
          </div>
        `;
        item.querySelector('.delete-card').addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          deleteSavedCard(card.id).catch((error) => showNotification(error.message, 'error'));
        });
        container.appendChild(item);
      });

      $('#new-card-option').checked = true;
      setupPaymentMethodRadios();
    }

    function setupPaymentMethodRadios() {
      document.querySelectorAll('input[name="payment-method"]').forEach((radio) => {
        radio.addEventListener('change', async () => {
          hideNotification();
          updatePaymentSummary(null);
          state.selectedCardToken = radio.value === 'new-card' ? '' : radio.value;
          $('#card-form').style.display = state.selectedCardToken ? 'none' : 'grid';
          $('#saved-card-installments').classList.toggle('show', Boolean(state.selectedCardToken));
          $('#saved-card-pay-button').style.display = state.selectedCardToken ? 'flex' : 'none';

          if (state.selectedCardToken) {
            try {
              await loadSavedCardFinancingOptions(state.selectedCardToken);
            } catch (error) {
              showNotification(`Could not load installments for saved card: ${error.message}`, 'warning');
            }
          }
        });
      });
    }

    async function handleSavedCardPayment() {
      if (!state.selectedCardToken) {
        showNotification('Select a saved card.', 'error');
        return;
      }

      setLoading(true);
      hideNotification();

      try {
        startTransactionRequest();
        await callSTC();
        const installment = readInstallmentFromSelect($('#saved-card-installments-select'));
        const payload = buildSavedCardOrderPayload(state.selectedCardToken, installment);
        const order = await paypalRequest('/v2/checkout/orders', {
          method: 'POST',
          // Tarjeta recordada = single step capture: el negative testing
          // se aplica en createOrder, no en captureOrder.
          headers: negativeTestHeaders(),
          body: JSON.stringify(payload)
        });
        if (!order.id) throw new Error('PayPal did not return an order ID.');

        const current = await getOrder(order.id);
        const capture = current?.purchase_units?.[0]?.payments?.captures?.[0];
        if (capture?.status === 'COMPLETED') {
          renderResult(current, 'success');
          showNotification('Payment captured successfully.', 'success');
          state.cmid = generateCMID();
          loadFraudnet(state.cmid);
        } else if (capture && capture.status !== 'COMPLETED') {
          // Capture existe pero el procesador la rechazó (DECLINED, etc.)
          const errPayload = buildCaptureDeclinedPayload(current, order.id);
          showNotification(errPayload.error, 'error');
          renderResult(errPayload, 'error');
        } else if (current.status === 'APPROVED' || order.status === 'APPROVED') {
          const captured = await captureOrder(order.id);
          if (isCaptureSuccessful(captured)) {
            renderResult(captured, 'success');
            showNotification('Payment captured successfully.', 'success');
            state.cmid = generateCMID();
            loadFraudnet(state.cmid);
          } else {
            const errPayload = buildCaptureDeclinedPayload(captured, order.id);
            showNotification(errPayload.error, 'error');
            renderResult(errPayload, 'error');
          }
        } else {
          throw new Error(`Token order is not ready for capture. Status: ${current.status || order.status}`);
        }
      } catch (error) {
        const errPayload = buildErrorPayload(error);
        showNotification(`Error processing saved card: ${errPayload.error}`, 'error');
        renderResult(errPayload, 'error');
      } finally {
        setLoading(false);
      }
    }

    /* ============================================================
       Card Fields SDK
       ============================================================ */

    async function loadPayPalSdk() {
      const generation = ++state.sdkLoadGeneration;
      const cfg = await getSdkInit();
      const idToken = cfg.idToken;

      if (!idToken) {
        throw new Error('Server did not return id_token. The Card Fields SDK requires data-sdk-client-token.');
      }

      const oldScript = document.getElementById(state.sdkScriptId);
      if (oldScript) oldScript.remove();
      delete window.paypal;
      state.cardField = null;

      const script = document.createElement('script');
      script.id = state.sdkScriptId;
      script.src = `https://www.paypal.com/sdk/js?currency=${encodeURIComponent(CURRENCY)}&components=card-fields&locale=en_US&client-id=${encodeURIComponent(cfg.clientId)}`;
      script.setAttribute('data-sdk-client-token', idToken);
      script.setAttribute('data-client-metadata-id', state.cmid);
      document.body.appendChild(script);

      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load the PayPal JS SDK.'));
      });

      if (generation !== state.sdkLoadGeneration) return;
      renderCardFields();
      await getSavedCards();
    }

    function renderCardFields() {
      if (!window.paypal || !paypal.CardFields) {
        throw new Error('PayPal Card Fields is not available in the loaded SDK.');
      }

      const cardField = paypal.CardFields({
        style: {
          input: {
            'font-size': '14px',
            'font-family': 'Inter, -apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif',
            color: '#202322',
            padding: '10px 14px'
          },
          '.invalid': { color: '#722822' },
          ':focus': { color: '#003087' },
          ':hover': { color: '#0070ba' }
        },
        createOrder: createOrderForNewCard,
        onApprove: async (data) => {
          setLoading(true);
          hideNotification();
          try {
            const captured = await validate3dsAndCapture(data.orderID, data);
            if (isCaptureSuccessful(captured)) {
              renderResult(captured, 'success');
              showNotification('Payment captured successfully.', 'success');
              state.cmid = generateCMID();
              loadFraudnet(state.cmid);
            } else {
              const errPayload = buildCaptureDeclinedPayload(captured, data.orderID);
              showNotification(errPayload.error, 'error');
              renderResult(errPayload, 'error');
            }
          } catch (error) {
            const errPayload = buildErrorPayload(error, data.orderID);
            showNotification(errPayload.error, 'error');
            renderResult(errPayload, 'error');
          } finally {
            setLoading(false);
          }
        },
        onError: (error) => {
          console.error('CardFields error:', error);

          // El SDK de Card Fields dispara onError cuando una llamada interna
          // (p.ej. /v2/checkout/orders/{id}/confirm-payment-source) falla.
          // Esa llamada ocurre dentro del iframe del SDK, así que no la captura
          // nuestro paypalRequest. Preferimos error.data (parseado) sobre
          // error.message (string con el JSON serializado y escapado) para no
          // duplicar la misma info en el log.
          // Ref: https://developer.paypal.com/studio/checkout/advanced/integrate
          let logEndpoint = 'CardFields onError';
          let logResponse;
          let logStatus = 'ERROR';
          let body = null;
          let shortMessage;

          if (error && typeof error === 'object' && error.data && typeof error.data === 'object') {
            logEndpoint = error.data.url || logEndpoint;
            logResponse = error.data.body || error.data;
            if (typeof error.data.status === 'number') logStatus = error.data.status;
            body = error.data.body || null;
          } else if (error && typeof error === 'object') {
            logResponse = {
              name: error.name,
              message: error.message,
              details: error.details,
              debug_id: error.debug_id,
              links: error.links
            };
            body = {
              name: error.name,
              message: error.message,
              details: error.details,
              debug_id: error.debug_id
            };
          } else {
            logResponse = { message: String(error) };
            shortMessage = String(error);
          }

          // Mensaje corto: primer detail.description > body.message > body.name > fallback
          if (!shortMessage) {
            shortMessage = (body?.details?.[0]?.description) || body?.message || body?.name || 'Card Fields error';
          }

          addLog({
            method: 'SDK',
            endpoint: logEndpoint,
            request: { mode: getThreeDsMode() },
            response: logResponse,
            status: logStatus
          });

          showNotification(`Card Fields error: ${shortMessage}`, 'error');
          renderResult({
            error: shortMessage,
            errorName: body?.name,
            errorDebugId: body?.debug_id,
            errorDetails: body?.details
          }, 'error');
          setLoading(false);
        },
        installments: {
          onInstallmentsRequested: () => ({
            financingCountryCode: 'MX',
            amount: getAmount(),
            currencyCode: CURRENCY,
            billingCountryCode: 'MX',
            includeBuyerInstallments: true
          }),
          onInstallmentsAvailable: (installments) => {
            populateInstallmentsSelect($('#installments'), installments?.financing_options || []);
          },
          onInstallmentsError: () => {
            const select = $('#installments');
            select.innerHTML = '<option value="">No financing options available</option>';
            select.disabled = true;
            updatePaymentSummary(null);
          }
        }
      });

      if (!cardField.isEligible()) {
        $('#card-form').style.display = 'none';
        showNotification('Card Fields is not eligible for this account, environment, or browser combination.', 'warning');
        return;
      }

      state.cardField = cardField;
      cardField.NumberField({ placeholder: 'Card number' }).render('#card-number-field-container');
      cardField.ExpiryField({ placeholder: 'MM / YY' }).render('#card-expiry-field');
      cardField.CVVField({ placeholder: 'Security code' }).render('#card-cvv-field');
      cardField.NameField({ placeholder: 'Name as it appears on card' }).render('#card-name-field-container');
    }

    async function submitNewCard() {
      if (!state.cardField) {
        showNotification('Card Fields is not ready yet.', 'warning');
        return;
      }
      hideNotification();
      setLoading(true);
      startTransactionRequest();

      const installment = readInstallmentFromSelect($('#installments'));
      const submitArgs = installment && installment.term > 1
        ? {
            installments: {
              term: installment.term,
              intervalDuration: installment.interval_duration,
              feeReferenceId: installment.fee_reference_id
            }
          }
        : {};

      try {
        await state.cardField.submit(submitArgs);
      } catch (error) {
        // El SDK ya disparó onError con la versión estructurada del error
        // (log + result card + notificación). Aquí solo cerramos el loader
        // para no mostrar el mismo error en formato crudo.
        console.warn('cardField.submit rejected:', error);
        setLoading(false);
      }
    }

    /* ============================================================
       Resultado y reset
       ============================================================ */

    // Convierte un Error capturado en el flujo (capture, getOrder, etc.) al
    // shape que renderResult espera para mostrar el cuadro estructurado.
    // Si error.response viene del API de PayPal (name, details[], debug_id),
    // lo expone como errorName / errorDebugId / errorDetails. Si no hay body
    // estructurado, regresa solo el message plano para fallback.
    // Una orden puede regresar HTTP 200/201 con `status: COMPLETED` a nivel
    // de orden, pero el capture interno puede haber sido DECLINED por el
    // procesador (p.ej. tarjetas Sandbox tipo CCREJECT-REFUSED, response_code
    // 0500). Estas decisiones requieren tratarse como error a pesar del 200.
    function isCaptureSuccessful(captureResult) {
      const capture = captureResult?.purchase_units?.[0]?.payments?.captures?.[0];
      return capture?.status === 'COMPLETED';
    }

    function buildCaptureDeclinedPayload(captureResult, fallbackOrderId) {
      const capture = captureResult?.purchase_units?.[0]?.payments?.captures?.[0];
      const orderId = captureResult?.id || fallbackOrderId;
      const status = capture?.status || captureResult?.status || 'UNKNOWN';
      const processor = (capture && capture.processor_response) || {};
      const cardName = captureResult?.payment_source?.card?.name;

      const details = [];
      if (cardName) details.push({ issue: 'card name', description: cardName });
      if (processor.response_code) details.push({ issue: 'processor response_code', description: processor.response_code });
      if (processor.avs_code) details.push({ issue: 'AVS', description: processor.avs_code });
      if (processor.cvv_code) details.push({ issue: 'CVV', description: processor.cvv_code });

      return {
        error: `Payment ${status.toLowerCase()}`,
        errorName: `Capture ${status}`,
        errorDetails: details,
        orderID: orderId
      };
    }

    function buildErrorPayload(error, fallbackOrderId) {
      console.debug('[buildErrorPayload] error:', error,
        'response:', error && error.response,
        'cause:', error && error.cause);

      // Busca el body estructurado del API de PayPal en varias ubicaciones
      // posibles: lo seteamos como err.response en paypalRequest, pero el SDK
      // o un wrapper podrían envolverlo en .cause / .body / .data.
      const candidates = [
        error && error.response,
        error && error.cause,
        error && error.body,
        error && error.data,
        error && error.data && error.data.body,
        error
      ];
      let body = null;
      for (const c of candidates) {
        if (c && typeof c === 'object' && (c.name || c.debug_id || (Array.isArray(c.details) && c.details.length > 0))) {
          body = c;
          break;
        }
      }

      const isStructured = !!body;
      const shortMessage = (body && body.details && body.details[0] && body.details[0].description)
        || (body && body.message)
        || (body && body.name)
        || (error && error.message)
        || 'Transaction could not be completed.';

      return {
        error: shortMessage,
        errorName: isStructured ? body.name : undefined,
        errorDebugId: isStructured ? body.debug_id : undefined,
        errorDetails: isStructured ? body.details : undefined,
        orderID: fallbackOrderId || undefined
      };
    }

    function renderResult(payload, type) {
      const result = $('#result');
      const capture = payload?.purchase_units?.[0]?.payments?.captures?.[0];
      const status = capture?.status || payload?.status || 'ERROR';
      const orderId = payload?.id || payload?.orderID || '';
      const captureId = capture?.id || '';
      const amount = capture?.amount ? formatMoney(capture.amount.value, capture.amount.currency_code) : formatMoney(getAmount());
      const liabilityShift = readLiabilityShift(payload, {});
      const liabilityRow = liabilityShift
        ? `<p><strong>Liability shift:</strong> <span class="code">${escapeHtml(liabilityShift)}</span></p>`
        : '';

      result.className = `result show ${type}`;

      if (type === 'success') {
        result.innerHTML = `
          <h2>Payment completed</h2>
          <p><strong>Status:</strong> ${escapeHtml(status)}</p>
          <p><strong>Order:</strong> <span class="code">${escapeHtml(orderId)}</span></p>
          <p><strong>Capture:</strong> <span class="code">${escapeHtml(captureId || 'N/A')}</span></p>
          <p><strong>Total:</strong> ${escapeHtml(amount)}</p>
          ${liabilityRow}
        `;
        return;
      }

      // Error: si trae body estructurado (errorName / errorDebugId / errorDetails),
      // pintamos campos limpios; si no, fallback al mensaje simple.
      const hasStructured = payload?.errorName || payload?.errorDebugId
        || (Array.isArray(payload?.errorDetails) && payload.errorDetails.length > 0);

      let html = `<h2>Payment stopped</h2>`;

      if (hasStructured) {
        if (payload.errorDebugId) {
          html += `<p><strong>Corr ID:</strong> <span class="code">${escapeHtml(payload.errorDebugId)}</span></p>`;
        }
        if (payload.errorName) {
          html += `<p><strong>Name:</strong> ${escapeHtml(payload.errorName)}</p>`;
        }
        if (Array.isArray(payload.errorDetails) && payload.errorDetails.length) {
          const items = payload.errorDetails.map((d) => {
            const field = d.field ? `<code>${escapeHtml(d.field)}</code>` : '';
            const issue = d.issue ? ` (${escapeHtml(d.issue)})` : '';
            const desc = d.description ? `: ${escapeHtml(d.description)}` : '';
            return `<li>${field}${issue}${desc}</li>`;
          }).join('');
          html += `<p><strong>Details:</strong></p><ul class="error-details">${items}</ul>`;
        }
      } else {
        html += `<p>${escapeHtml(payload?.error || 'Transaction could not be completed.')}</p>`;
      }

      if (orderId) {
        html += `<p><strong>Order:</strong> <span class="code">${escapeHtml(orderId)}</span></p>`;
      }
      html += liabilityRow;

      result.innerHTML = html;
    }

    function clearCardContainers() {
      ['#card-number-field-container', '#card-expiry-field', '#card-cvv-field', '#card-name-field-container'].forEach((selector) => {
        const node = $(selector);
        if (node) node.innerHTML = '';
      });
      $('#installments').innerHTML = '<option value="">Fill in the card to see financing options</option>';
      $('#installments').disabled = true;
    }

    async function resetFlow({ clearLogPanel = true } = {}) {
      if (state.isResetting) return;
      state.isResetting = true;
      setLoading(false);
      hideNotification();
      $('#result').className = 'result';
      $('#result').innerHTML = '';
      if (clearLogPanel) clearLogs();
      clearCardContainers();
      updatePaymentSummary(null);
      updateEnvHint();
      state.sdkConfig = null;
      state.currentRequestId = '';
      state.cmid = generateCMID();
      state.selectedCardToken = '';
      $('#vault').checked = false;

      try {
        await getSdkInit({ force: true });
        loadFraudnet(state.cmid);
        await loadPayPalSdk();
        showNotification('Flow restarted with the selected configuration.', 'info');
      } catch (error) {
        showNotification(`Could not initialize the demo: ${error.message}`, 'error');
      } finally {
        state.isResetting = false;
      }
    }

    function bindEvents() {
      setupCredsModal();
      $('#card-field-submit-button').addEventListener('click', submitNewCard);
      $('#saved-card-pay-button').addEventListener('click', handleSavedCardPayment);
      $('#reset-button').addEventListener('click', () => resetFlow({ clearLogPanel: true }));
      $('#clear-logs-button').addEventListener('click', clearLogs);

      $('#installments').addEventListener('change', () => {
        updatePaymentSummary(readInstallmentFromSelect($('#installments')));
      });
      $('#saved-card-installments-select').addEventListener('change', () => {
        updatePaymentSummary(readInstallmentFromSelect($('#saved-card-installments-select')));
      });

      $('#amount').addEventListener('change', () => {
        const amount = getAmount();
        $('#amount').value = amount;
        updateEnvHint();
        resetFlow({ clearLogPanel: false });
      });

      document.querySelectorAll('input[name="paypal-env"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          updateEnvHint();
          resetFlow({ clearLogPanel: false });
        });
      });

      document.querySelectorAll('input[name="three-ds-mode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          showNotification(
            getThreeDsMode() === 'merchant'
              ? 'Merchant Initiated active: createOrder will include verification.method = SCA_ALWAYS.'
              : 'Risk Initiated active: PayPal decides whether to trigger 3DS based on risk.',
            'info'
          );
        });
      });

    }

    async function init() {
      bindEvents();
      updatePaymentSummary(null);
      updateEnvHint();
      state.cmid = generateCMID();
      try {
        await getSdkInit({ force: true });
        loadFraudnet(state.cmid);
        await loadPayPalSdk();
      } catch (error) {
        showNotification(`Could not initialize the demo: ${error.message}. Check server logs and .env values.`, 'error');
      }
    }

    init();
