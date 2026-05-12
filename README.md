# ACDC Server-Side Demo

Demo de PayPal Advanced Credit and Debit Card (ACDC) convertido a arquitectura server-side. El navegador renderiza la experiencia de checkout con PayPal Card Fields, pero las credenciales, OAuth, `access_token` y llamadas REST de negocio viven en el servidor Express.

La guía funcional y técnica completa está en `Documentation and Skill/HOWTOINTEGRATE.md` (español) y `Documentation and Skill/HOWTOINTEGRATE_EN.md` (inglés).

## Requisitos

- Node.js 18 o superior.
- Credenciales PayPal Sandbox y, opcionalmente, Live.
- Cuenta PayPal con las capacidades que quieras probar: ACDC/Card Fields, Vault, Installments/IC2B, STC/Fraudnet y 3DS según aplique.

## Instalación

```bash
npm install
```

## Configuración

Al correr el sample code por primera vez, el servidor crea automáticamente un `.env` con credenciales de prueba Sandbox/Live y un `CUSTOMER_ID` inicial si el archivo no existe. Puedes arrancar el proyecto inmediatamente con esos valores demo y después reemplazarlos desde la sección **CREDS** de la UI.

Si prefieres preparar la configuración manualmente antes de arrancar, copia `.env.example` a `.env` y coloca tus valores reales.

```bash
cp .env.example .env
```

Variables requeridas:

```bash
SANDBOX_CLIENT_ID=your_sandbox_client_id
SANDBOX_CLIENT_SECRET=your_sandbox_client_secret
SANDBOX_API_BASE=https://api-m.sandbox.paypal.com
SANDBOX_MERCHANT_ID=your_sandbox_merchant_id

LIVE_CLIENT_ID=your_live_client_id
LIVE_CLIENT_SECRET=your_live_client_secret
LIVE_API_BASE=https://api-m.paypal.com
LIVE_MERCHANT_ID=your_live_merchant_id

PORT=3000
CUSTOMER_ID=your_customer_id
```

No subas `.env` a repositorios. El archivo está ignorado por `.gitignore`.

También puedes editar estas credenciales desde el botón **CREDS** en la barra superior. Al guardar, el servidor sobreescribe el `.env`, actualiza las variables en memoria e invalida el cache de tokens para que el nuevo valor se use en la siguiente inicialización.

## Arrancar el proyecto

Modo normal:

```bash
npm start
```

Modo desarrollo con reload de Node:

```bash
npm run dev
```

Luego abre:

```text
http://localhost:3000
```

Si el puerto `3000` está ocupado, cambia `PORT` en `.env` o arranca con otro valor:

```bash
PORT=3001 npm start
```

## Estructura

```text
.
├── Documentation and Skill/   # Guías de integración y skill de Claude Code
├── README.md                  # Esta documentación
├── server.js              # Proxy server-side hacia PayPal
├── package.json           # Scripts y dependencias
├── .env.example           # Plantilla de configuración
└── public
    ├── index.html         # UI del checkout
    ├── style.css          # Estilos del demo
    └── app.js             # Lógica cliente, SDK, Card Fields y logs
```

## Flujo General

1. El cliente genera un CMID por sesión de checkout.
2. El cliente inyecta Fraudnet con ese CMID.
3. El cliente pide `/api/sdk-init` al servidor.
4. El servidor obtiene OAuth en PayPal y devuelve `clientId` + `idToken` al cliente.
5. El cliente carga el PayPal JavaScript SDK con `data-sdk-client-token` y `data-client-metadata-id`.
6. Card Fields crea la orden usando callbacks del SDK.
7. El cliente llama solo a `/api/...`; el servidor reenvía a PayPal con `Authorization`, `PayPal-Client-Metadata-Id` y `PayPal-Request-Id`.
8. En `onApprove`, el cliente valida `liabilityShift`; solo captura si es seguro hacerlo.

## Endpoints del servidor

El frontend nunca llama directamente a REST PayPal. Usa estos endpoints locales:

| Endpoint local | PayPal API |
|---|---|
| `GET /api/sdk-init` | `POST /v1/oauth2/token` |
| `POST /api/orders` | `POST /v2/checkout/orders` |
| `GET /api/orders/:id` | `GET /v2/checkout/orders/:id` |
| `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/:id/capture` |
| `PUT /api/stc` | `PUT /v1/risk/transaction-contexts/:merchantId/:cmid` |
| `GET /api/vault/payment-tokens` | `GET /v3/vault/payment-tokens` |
| `DELETE /api/vault/payment-tokens/:id` | `DELETE /v3/vault/payment-tokens/:id` |
| `POST /api/financing-options` | `POST /v1/credit/calculated-financing-options` |
| `GET /api/health` | Health check local |

## Logs

El panel **API / Client logs** muestra la vista útil para integración:

- Endpoints PayPal reales, no las rutas internas `/api/...`.
- Requests y responses completos cuando PayPal los devuelve.
- `Authorization`, secretos, `id_token` y campos sensibles se enmascaran.
- `access_token` muestra solo los primeros 5 caracteres y el resto como `*`.
- Eventos cliente como `SCRIPT`, `SDK` y `3DS` también aparecen para correlación.

## Funcionalidades Incluidas

- Pago con tarjeta nueva usando PayPal Card Fields.
- Vault-with-Purchase mediante checkbox para guardar tarjeta.
- Listado y eliminación de tarjetas guardadas.
- Pago con tarjeta guardada usando `PAYMENT_METHOD_TOKEN`.
- MSI (Meses Sin Intereses / Installments) e IC2B/MCI (Meses Con Intereses) para tarjeta nueva y tarjeta guardada.
- Fraudnet con CMID por sesión.
- STC antes de crear órdenes.
- 3DS Risk Initiated y Merchant Initiated, como en la demo original.
- Negative testing con mocks PayPal para issuer/risk declines.

## 3DS

La UI incluye selector:

- `Risk Init`: PayPal decide si dispara 3DS basado en riesgo.
- `Merchant Init`: el payload incluye `payment_source.card.attributes.verification.method = "SCA_ALWAYS"`.

Después de `onApprove`, el cliente consulta la orden, revisa `liabilityShift` y solo captura si:

- `liabilityShift` no está presente, o
- `liabilityShift === "POSSIBLE"`.

Si el valor es desfavorable, el pago se detiene y no se captura.

## Pruebas Rápidas

Validar sintaxis:

```bash
node --check server.js
node --check public/app.js
```

Validar dependencias:

```bash
npm audit --audit-level=moderate
```

Validar servidor:

```bash
curl http://localhost:3000/api/health
```

Validar inicialización del SDK sin imprimir tokens:

```bash
curl -s http://localhost:3000/api/sdk-init?env=sandbox | node -e \
  "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
   console.log({status:200,hasClientId:Boolean(d.clientId),hasMerchantId:Boolean(d.merchantId),hasIdToken:Boolean(d.idToken)})"
```

## Notas de seguridad

- `CLIENT_SECRET` nunca debe llegar al navegador.
- `access_token` nunca debe llegar al navegador como dato operativo.
- El PAN y CVV nunca pasan por el backend; los captura PayPal Card Fields en iframes.
- En producción usa HTTPS.
- Revisa `HOWTOINTEGRATE.md` antes de mover cualquier cambio a Live.

## Problemas comunes

- **El SDK no carga:** revisa `SANDBOX_CLIENT_ID`, `SANDBOX_CLIENT_SECRET`, `SANDBOX_MERCHANT_ID` y que OAuth devuelva `id_token`.
- **Card Fields no es elegible:** confirma que la cuenta tenga ACDC habilitado.
- **Vault no lista tarjetas:** confirma permisos Vault y que `customer.id` sea estable.
- **STC falla:** debe verse en logs, pero no bloquea el checkout.
- **3DS no aparece en Sandbox:** usa tarjetas 3DS compatibles y el nombre requerido por PayPal para el caso de prueba.
