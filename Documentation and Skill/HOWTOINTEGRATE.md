# Solution Design Document — Integración ACDC con PayPal JavaScript SDK

| Metadato | Valor |
|----------|-------|
| **Tipo de documento** | Solution Design Document (SDD) |
| **Solución** | Procesamiento de tarjetas de crédito y débito en checkout web mediante PayPal Advanced Credit and Debit Card (ACDC) |
| **Componentes técnicos** | PayPal JavaScript SDK · Card Fields · Vault v3 · Calculated Financing Options · Risk Transaction Contexts (STC) · Fraudnet |
| **Capacidades funcionales** | Cobro con tarjeta nueva · Tokenización (Vault-with-Purchase) · Cobro con tarjeta guardada · Installments (MSI / MCI) · 3DS Risk Initiated · Pre-evaluación de riesgo (Fraudnet + STC) |
| **APIs REST involucradas** | `/v1/oauth2/token`, `/v2/checkout/orders`, `/v3/vault/payment-tokens`, `/v1/credit/calculated-financing-options`, `/v1/risk/transaction-contexts` |
| **Convenciones** | REST → `snake_case` · SDK JavaScript → `camelCase` |
| **Audiencia** | Equipos de Solution Architecture, Integration Engineering, Product, e-commerce, Riesgo y Cumplimiento PCI |

---

## Tabla de contenidos

### Parte I — Contexto de la solución
1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Contexto de negocio y drivers](#2-contexto-de-negocio-y-drivers)
3. [Alcance de la solución](#3-alcance-de-la-solución)
4. [Stakeholders y audiencia](#4-stakeholders-y-audiencia)
5. [Glosario de términos y acrónimos](#5-glosario-de-términos-y-acrónimos)

### Parte II — Definición de la solución
6. [Visión general de la solución](#6-visión-general-de-la-solución)
7. [Requisitos funcionales](#7-requisitos-funcionales)
8. [Requisitos no funcionales](#8-requisitos-no-funcionales)
9. [Arquitectura de la solución](#9-arquitectura-de-la-solución)
10. [Prerrequisitos y configuración del entorno](#10-prerrequisitos-y-configuración-del-entorno)

### Parte III — Diseño detallado
11. [Autenticación OAuth2 y emisión del `id_token`](#11-autenticación-oauth2-y-emisión-del-id_token)
12. [Generación del Client Metadata ID (CMID)](#12-generación-del-client-metadata-id-cmid)
13. [Integración de Fraudnet](#13-integración-de-fraudnet)
14. [Set Transaction Context (STC)](#14-set-transaction-context-stc)
15. [Carga del JavaScript SDK de PayPal](#15-carga-del-javascript-sdk-de-paypal)
16. [Estructura HTML y estilos de Card Fields](#16-estructura-html-y-estilos-de-card-fields)
17. [Creación y captura de órdenes](#17-creación-y-captura-de-órdenes)
18. [MSI y MCI](#18-msi-y-mci)
19. [Vault — Tokenización de tarjetas](#19-vault--tokenización-de-tarjetas)
20. [3DS Risk Initiated y `liabilityShift`](#20-3ds-risk-initiated-y-liabilityshift)

### Parte IV — Integración y operación
21. [Orquestación end-to-end](#21-orquestación-end-to-end)
22. [Caso de uso especializado — BOPIS](#22-caso-de-uso-especializado--bopis)
23. [Puntos de integración (mapa de endpoints)](#23-puntos-de-integración-mapa-de-endpoints)
24. [Consideraciones de seguridad](#24-consideraciones-de-seguridad)
25. [Consideraciones operativas](#25-consideraciones-operativas)

### Parte V — Validación y gobierno
26. [Estrategia de pruebas y tarjetas de Sandbox](#26-estrategia-de-pruebas-y-tarjetas-de-sandbox)
27. [Convenciones de nombres REST vs SDK](#27-convenciones-de-nombres-rest-vs-sdk)
28. [Asunciones, dependencias y restricciones](#28-asunciones-dependencias-y-restricciones)
29. [Riesgos y mitigaciones](#29-riesgos-y-mitigaciones)
30. [Criterios de aceptación y checklist pre-producción](#30-criterios-de-aceptación-y-checklist-pre-producción)

### Apéndices
- [Apéndice A — Diagnóstico de errores frecuentes](#apéndice-a--diagnóstico-de-errores-frecuentes)
- [Apéndice B — Limitaciones y trabajo futuro](#apéndice-b--limitaciones-y-trabajo-futuro)

---

# Parte I — Contexto de la solución

## 1. Resumen ejecutivo

Este Solution Design Document define la integración de **PayPal Advanced Credit and Debit Card (ACDC)** en una experiencia de checkout web. La solución habilita el cobro con tarjetas de crédito y débito directamente en el sitio del comercio mediante el componente **Card Fields** del **PayPal JavaScript SDK**, integrado con cinco capacidades adicionales de PayPal: tokenización (Vault), pagos a meses (MSI y MCI), autenticación 3-D Secure en modalidad Risk Initiated, y dos servicios de evaluación de riesgo (Fraudnet y Set Transaction Context).

La solución está dirigida a comercios que requieren:

- **Reducción del alcance PCI DSS**, manteniendo SAQ A al evitar que el PAN y el CVV toquen su infraestructura.
- **Conversión optimizada** mediante cobro nativo en el sitio (sin redirección al checkout de PayPal).
- **Protección frente a contracargos** mediante Chargeback Protection (CBP) y autenticación 3DS Risk Initiated.
- **Reutilización de tarjetas** del comprador en compras subsecuentes mediante tokens opacos de Vault.
- **Mensualidades** con o sin intereses para el comprador en mercados elegibles.
- **Evaluación de riesgo pre-transaccional** mediante device fingerprinting (Fraudnet) y contexto del comprador (STC).

El presente documento describe la solución de extremo a extremo: contexto de negocio, requisitos, arquitectura, diseño detallado por componente, orquestación, seguridad, operación, pruebas, riesgos y criterios de aceptación.

---

## 2. Contexto de negocio y drivers

### 2.1 Drivers de negocio

| Driver | Descripción |
|--------|-------------|
| **Conversión y experiencia de usuario** | Mantener al comprador dentro del sitio del comercio durante el cobro reduce la fricción frente a un checkout redirigido. Card Fields permite que la marca, los estilos y la navegación pertenezcan al comercio. |
| **Reducción de costos PCI DSS** | El uso de iframes hospedados por PayPal aísla el PAN y el CVV del entorno del comercio, permitiendo cumplimiento PCI bajo el cuestionario simplificado SAQ A en lugar de SAQ D. |
| **Protección contra fraude y contracargos** | La combinación de 3DS Risk Initiated + Chargeback Protection traslada al banco emisor la responsabilidad por contracargos fraudulentos cuando 3DS es exitoso. |
| **Aumento del ticket promedio mediante Installments** | Las modalidades MSI (Meses Sin Intereses, costo absorbido por el comercio) y MCI (Meses Con Intereses, costo pagado por el comprador) en mercados elegibles incrementan tasas de conversión y ticket promedio. |
| **Recurrencia y retención** | Vault permite cobrar a tarjetas guardadas sin re-ingreso por parte del comprador, reduciendo la fricción en compras subsecuentes y habilitando casos de uso de suscripción y one-click checkout. |
| **Evaluación de riesgo enriquecida** | Fraudnet y STC alimentan el motor de riesgo de PayPal con telemetría del navegador y contexto del comprador, mejorando las tasas de aprobación de buenas transacciones y reduciendo falsos positivos. |

### 2.2 Drivers regulatorios y de cumplimiento

| Driver | Descripción |
|--------|-------------|
| **PCI DSS** | El estándar exige que el manejo de datos de tarjeta cumpla controles estrictos. Card Fields delega ese manejo a PayPal. |
| **PSD2 / SCA (Strong Customer Authentication)** en Europa, equivalentes regionales | 3DS Risk Initiated proporciona la autenticación reforzada cuando el motor de riesgo o el banco emisor lo demandan. |
| **Regulaciones locales de protección al consumidor** | El consentimiento explícito para guardar la tarjeta (Vault-with-Purchase) y la transparencia del cargo de financiamiento (MCI) deben reflejarse en la UI conforme a la normativa del mercado destino. |

---

## 3. Alcance de la solución

### 3.1 Capacidades en alcance

| Capacidad | Descripción |
|-----------|-------------|
| **Cobro con tarjeta nueva** | Captura de datos de tarjeta vía Card Fields (iframes de PayPal) y procesamiento mediante Create Order + Capture Order. |
| **Tokenización (Vault-with-Purchase)** | Guardado opcional de la tarjeta al completar la primera compra exitosa. |
| **Listado y eliminación de tokens** | Gestión de los métodos de pago guardados de un comprador. |
| **Cobro con tarjeta guardada (token)** | Reutilización de un `PAYMENT_METHOD_TOKEN` para crear órdenes sin re-ingreso de datos. |
| **Installments — MSI** | Compras a meses sin intereses para el comprador (costo absorbido por el comercio). |
| **Installments — MCI** | Compras a meses con costo de financiamiento al comprador. |
| **3DS Risk Initiated** | Autenticación 3-D Secure decidida por el motor de riesgo de PayPal; el comercio no envía instrucciones 3DS, solo valida `liabilityShift` en `onApprove`. |
| **Fraudnet** | Recolección de telemetría de dispositivo y navegador en el cliente. |
| **Set Transaction Context (STC)** | Envío de contexto del comprador al motor de riesgo antes de cada Create Order. |
| **BOPIS** | Variante del payload de envío para pickup en tienda física. |

### 3.2 Capacidades fuera de alcance

| Capacidad | Razón de exclusión |
|-----------|-------------------|
| Pago con cuenta PayPal o botón de marca PayPal | La solución se centra exclusivamente en cobro con tarjeta vía Card Fields. |
| Métodos de pago alternativos (APMs): Pay Later, BNPL, Venmo, billeteras locales | No requeridos por el alcance ACDC. Pueden incorporarse en una solución complementaria. |
| **3DS Merchant Initiated** | Aplica a cuentas con Fraud Protection (FP); este SDD describe el flujo Risk Initiated, exclusivo de cuentas con Chargeback Protection (CBP). |
| Suscripciones y planes recurrentes orquestados por PayPal Billing Plans | El cobro recurrente mediante token de Vault sí está cubierto; las suscripciones gestionadas por PayPal Billing son una solución distinta. |
| Webhooks de eventos asíncronos (refunds, disputas, settlement) | Requieren un SDD complementario de back-office. |
| Reembolsos, parciales o totales | Operación de back-office no cubierta por este SDD. |
| Conciliación contable y reporting financiero | Fuera del alcance del checkout. |

---

## 4. Stakeholders y audiencia

| Rol | Responsabilidad respecto a este SDD |
|-----|-------------------------------------|
| **Solution Architect** | Valida la arquitectura, asegura la consistencia con el portafolio del comercio y aprueba el documento. |
| **Product Manager (e-commerce)** | Valida que el alcance funcional cubre los requisitos de negocio y la experiencia de checkout deseada. |
| **Integration Engineer (PayPal)** | Apoya al comercio en la implementación, valida configuraciones comerciales (CBP, Vault, Installments, STC) y entrega industry packs cuando aplica. |
| **Integration Engineer / Tech Lead (comercio)** | Lidera la implementación técnica y es propietario del código del frontend y del backend. |
| **Equipo de desarrollo del comercio** | Implementa y mantiene la integración. |
| **Equipo de Riesgo y Antifraude (comercio)** | Valida la configuración de Fraudnet y STC, define el set de campos `additional_data` y monitorea métricas de fraude. |
| **Equipo de Cumplimiento PCI (comercio)** | Verifica que la integración mantiene el alcance SAQ A y aprueba la configuración de seguridad. |
| **Equipo de QA (comercio)** | Ejecuta el plan de pruebas en Sandbox antes de la promoción a Live. |
| **Operaciones (comercio)** | Monitorea el checkout en producción, gestiona alertas e incidentes. |

---

## 5. Glosario de términos y acrónimos

| Término | Definición |
|---------|------------|
| **ACDC** | *Advanced Credit and Debit Card.* Producto de PayPal para procesar tarjetas de crédito y débito directamente en el sitio del comercio mediante el JavaScript SDK con Card Fields. |
| **Card Fields** | Componente del SDK que renderiza los campos de tarjeta como `<iframe>` hospedados por el dominio de PayPal. El **PAN** y el **CVV** nunca llegan al servidor del comercio, lo que reduce significativamente el alcance PCI DSS. |
| **Order** | Recurso REST (`/v2/checkout/orders`) que representa la intención de cobro: monto, breakdown, items, comprador y método de pago. Identificado por `order_id`. |
| **Capture** | Operación que ejecuta el cobro real contra el método de pago de la orden (`POST /v2/checkout/orders/{id}/capture`). Hasta que ocurre la captura, el dinero no se mueve. |
| **`intent`** | Campo de la orden que indica `CAPTURE` (cobrar al aprobar) o `AUTHORIZE` (solo retener fondos para captura posterior). El uso típico de e-commerce es `CAPTURE`. |
| **Vault** | Servicio de tokenización de PayPal. Almacena el método de pago de forma segura y devuelve un **`PAYMENT_METHOD_TOKEN`** opaco que el comercio usa para cobrar en transacciones futuras. |
| **`PAYMENT_METHOD_TOKEN`** | Identificador opaco de un método de pago guardado en Vault. **No** contiene datos sensibles de la tarjeta. |
| **`customer.id`** | Identificador estable del comprador en la plataforma del comercio. Vincula los tokens de Vault a un mismo usuario. Debe ser determinista entre sesiones. |
| **MSI** | *Meses Sin Intereses.* El costo del financiamiento lo absorbe el comercio. Se identifica por `total_consumer_fee.value === "0.00"`. |
| **MCI** | *Meses Con Intereses.* El costo del financiamiento lo paga el comprador. Se identifica por `total_consumer_fee.value > "0.00"`. Requiere `fee_reference_id` en el submit. |
| **3-D Secure (3DS)** | Protocolo de autenticación del comprador frente al banco emisor (Verified by Visa, Mastercard SecureCode, Amex SafeKey). Cuando es exitoso, transfiere la responsabilidad del fraude al emisor. |
| **3DS Risk Initiated** | Modalidad en la que el motor de riesgo de PayPal decide si lanzar 3DS. El comercio **no** envía instrucciones 3DS; únicamente valida el resultado en `onApprove` mediante `liabilityShift`. Requiere **Chargeback Protection (CBP)**. |
| **3DS Merchant Initiated** | Modalidad en la que el comercio decide explícitamente cuándo forzar 3DS mediante `payment_source.card.attributes.verification`. Requiere **Fraud Protection (FP)**. **No** está en el alcance de este SDD. |
| **`liabilityShift`** | Campo del callback `onApprove` que indica el resultado de 3DS. Valores típicos: `undefined` (sin desafío), `"POSSIBLE"` (3DS exitoso, shift al emisor), `"N"` (fallido), `"U"` (no disponible). |
| **`access_token`** | Token Bearer OAuth2 que el servidor usa para autenticarse con la API REST de PayPal. **Nunca** debe enviarse al navegador. |
| **`id_token`** | Token JWT que el servidor entrega al navegador para inicializar el SDK de forma autenticada. Se asigna al atributo `data-sdk-client-token` del script del SDK. |
| **CMID** | *Client Metadata ID.* Identificador alfanumérico de **hasta 32 caracteres sin guiones**, generado **una sola vez por sesión de checkout**. La práctica común es usar un UUID v4 sin guiones (32 caracteres), pero cualquier identificador único alfanumérico de longitud menor o igual a 32 es válido. Funciona como hilo de correlación entre Fraudnet, STC, el SDK y los headers `PayPal-Client-Metadata-Id` de Create Order y Capture Order. |
| **Fraudnet** | Snippet JavaScript de PayPal que recopila device fingerprinting y señales de comportamiento del navegador, y las transmite a PayPal Risk. Se compone de dos `<script>` que deben inyectarse **una sola vez** por sesión. |
| **STC** | *Set Transaction Context.* Endpoint `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` mediante el cual el comercio envía contexto del comprador a PayPal **antes de cada Create Order**, para una evaluación de riesgo pre-transaccional. Es **no bloqueante**: errores nunca deben detener el checkout. |
| **CBP** | *Chargeback Protection.* Producto comercial de PayPal que cubre disputas elegibles. Es prerrequisito para 3DS Risk Initiated. |
| **PCI DSS** | *Payment Card Industry Data Security Standard.* Estándar de seguridad para el manejo de datos de tarjeta. Card Fields permite cumplir con **SAQ A** porque el PAN/CVV nunca tocan la infraestructura del comercio. |
| **SAQ A** | *Self-Assessment Questionnaire A.* Cuestionario PCI simplificado aplicable cuando el comercio no almacena, procesa ni transmite datos de cuenta. |
| **PSD2** | *Payment Services Directive 2.* Regulación europea que exige Strong Customer Authentication (SCA) para ciertos tipos de transacciones. |
| **SCA** | *Strong Customer Authentication.* Autenticación reforzada del comprador exigida por PSD2; 3DS es uno de los mecanismos válidos. |
| **BOPIS** | *Buy Online, Pickup In Store.* Modalidad en la que el comprador paga en línea pero recoge el pedido en una tienda física. Modifica la representación del objeto `shipping` de la orden. |
| **APM** | *Alternative Payment Method.* Método de pago distinto a tarjeta de crédito/débito (billeteras, transferencias, BNPL, etc.). Fuera del alcance de este SDD. |
| **NFR** | *Non-Functional Requirement.* Requisito no funcional. |

---

# Parte II — Definición de la solución

## 6. Visión general de la solución

La solución se compone de **tres planos** con responsabilidades estrictamente delimitadas y un **identificador de correlación** (CMID) que atraviesa los tres durante toda la sesión de checkout.

| Plano | Responsabilidad | Lo que NO hace |
|-------|----------------|----------------|
| **Navegador del comprador** | Genera el CMID, inyecta Fraudnet, monta el SDK, renderiza Card Fields, captura interacciones, dispara `submit` y reacciona al resultado. | Nunca conoce `CLIENT_SECRET`, `access_token` ni `MERCHANT_ID`. Nunca llama directamente a la API REST de PayPal para operaciones de negocio. |
| **Backend del comercio** | Custodia las credenciales, obtiene `access_token` mediante OAuth2, expone endpoints proxy hacia PayPal, inyecta los headers `PayPal-Request-Id` y `PayPal-Client-Metadata-Id`, ejecuta STC. | Nunca recibe el PAN ni el CVV. Nunca expone `access_token` al frontend. |
| **API REST de PayPal** | Procesa órdenes, capturas, tokens de Vault, opciones de Installments, contexto de riesgo (STC) y autenticación 3DS. | Es la única fuente de verdad transaccional. |

### 6.1 Componentes de la solución

| Componente | Plano | Función |
|-----------|-------|---------|
| **Card Fields** | Navegador | Renderiza inputs de tarjeta como iframes seguros. |
| **Fraudnet** | Navegador | Telemetría de dispositivo/navegador. |
| **PayPal JavaScript SDK** | Navegador | Orquesta Card Fields, callbacks de Installments, ejecución de 3DS. |
| **OAuth2 Service** | Backend | Obtiene y cachea `access_token`; expone `id_token` al frontend. |
| **Orders Proxy** | Backend | Crea y captura órdenes. Inyecta headers de idempotencia y correlación. |
| **Vault Proxy** | Backend | Lista y elimina tokens. |
| **Installments Proxy** | Backend | Consulta opciones de financiamiento para tokens guardados. |
| **STC Proxy** | Backend | Envía contexto del comprador a `/v1/risk/transaction-contexts`. |
| **API REST PayPal** | PayPal | Procesamiento real. |

### 6.2 Identificador de correlación: el CMID

El **CMID** (Client Metadata ID) es un identificador alfanumérico de hasta 32 caracteres sin guiones, generado una sola vez por sesión de checkout. La implementación recomendada es un UUID v4 sin guiones (32 caracteres), pero el contrato de PayPal acepta cualquier identificador único alfanumérico con longitud entre 1 y 32 caracteres. Atraviesa los tres planos:

```
Navegador                       Backend del comercio              API PayPal
─────────                       ────────────────────              ──────────
1. genera CMID
2. CMID → Fraudnet "f"
3. CMID → SDK data-client-metadata-id
4. CMID → body._cmid de /api/orders ──→  PayPal-Client-Metadata-Id ──→ /v2/checkout/orders
                                          PayPal-Client-Metadata-Id ──→ /v2/checkout/orders/{id}/capture
                                                                  ──→  /v1/risk/transaction-contexts/{mid}/{cmid}
```

Sin un CMID consistente entre los tres planos, PayPal Risk no puede correlacionar las señales de Fraudnet, el contexto de STC y la transacción real, lo que degrada la calidad de la evaluación de riesgo.

---

## 7. Requisitos funcionales

| ID | Requisito | Prioridad |
|----|-----------|-----------|
| **RF-01** | El sistema debe permitir al comprador ingresar los datos de su tarjeta (número, expiración, CVV, nombre) sin que estos viajen al backend del comercio. | Obligatorio |
| **RF-02** | El sistema debe crear una orden con `intent: "CAPTURE"` y un breakdown matemáticamente consistente (item_total + tax_total + shipping − discount = amount.value). | Obligatorio |
| **RF-03** | El sistema debe ejecutar la captura del pago únicamente cuando el resultado de 3DS sea favorable (`liabilityShift` ausente o igual a `"POSSIBLE"`). | Obligatorio |
| **RF-04** | El sistema debe ofrecer al comprador la opción de guardar su tarjeta para futuras compras (Vault-with-Purchase) mediante consentimiento explícito. | Obligatorio |
| **RF-05** | El sistema debe listar las tarjetas guardadas de un comprador autenticado y permitirle pagar con un token sin re-ingresar los datos. | Obligatorio |
| **RF-06** | El sistema debe permitir al comprador eliminar una tarjeta guardada de su perfil. | Obligatorio |
| **RF-07** | El sistema debe presentar al comprador las opciones de financiamiento a meses (Installments) elegibles para su tarjeta y monto, distinguiendo MSI y MCI con etiquetas claras. | Obligatorio |
| **RF-08** | El sistema debe transmitir a PayPal Risk el contexto del comprador (perfil, antigüedad, vertical, nivel de confianza) antes de cada Create Order, sin bloquear el checkout en caso de error. | Obligatorio |
| **RF-09** | El sistema debe inyectar Fraudnet en el navegador una sola vez por sesión de checkout, con el CMID generado al inicio. | Obligatorio |
| **RF-10** | El sistema debe mostrar al comprador un mensaje claro y accionable cuando 3DS falle, sin capturar el pago. | Obligatorio |
| **RF-11** | El sistema debe soportar el caso de uso BOPIS sustituyendo el objeto `shipping` con la dirección del punto de pickup. | Opcional (depende del modelo del comercio) |
| **RF-12** | El sistema debe permitir reintentos del comprador dentro de una misma sesión de checkout sin regenerar el CMID ni recargar Fraudnet. | Obligatorio |

---

## 8. Requisitos no funcionales

| ID | Categoría | Requisito |
|----|-----------|-----------|
| **NFR-01** | **Seguridad — PCI DSS** | El PAN y el CVV nunca deben tocar la infraestructura del comercio. La integración debe permitir cumplimiento bajo SAQ A. |
| **NFR-02** | **Seguridad — secretos** | `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` y `access_token` nunca deben transmitirse al navegador, ni almacenarse en código fuente versionado, ni aparecer en logs. |
| **NFR-03** | **Seguridad — transporte** | Todas las comunicaciones (navegador ↔ backend, backend ↔ PayPal) deben usar TLS 1.2 o superior. |
| **NFR-04** | **Seguridad — CSP** | El sitio debe declarar una Content Security Policy que liste explícitamente los orígenes de PayPal (`www.paypal.com`, `www.paypalobjects.com`, `c.paypal.com`, `api-m.paypal.com`). |
| **NFR-05** | **Disponibilidad** | La caída de servicios accesorios (STC, Fraudnet) **no** debe interrumpir el flujo de pago. Su comportamiento es no bloqueante. |
| **NFR-06** | **Idempotencia** | El sistema debe garantizar que reintentos de Create Order o Capture Order no generen órdenes ni capturas duplicadas mediante `PayPal-Request-Id`. |
| **NFR-07** | **Latencia (p95)** | El tiempo total entre `submit` y respuesta al usuario no debe exceder los SLOs internos del comercio. La caché del `access_token` (§11.3) y el procesamiento no bloqueante de STC son esenciales para cumplirlo. |
| **NFR-08** | **Trazabilidad** | El sistema debe loguear `liabilityShift`, `enrollment_status`, `authentication_status`, `order_id`, `capture_id`, decisión de captura y código de error PayPal, sin loguear PAN ni CVV. |
| **NFR-09** | **Internacionalización** | El SDK debe cargarse con el `locale` correspondiente al mercado destino y los mensajes de error deben traducirse. |
| **NFR-10** | **Accesibilidad** | La UI de Card Fields debe cumplir WCAG 2.1 AA: labels asociados, mensajes de error con `aria-live`, contraste suficiente, no depender solo de color para indicar invalidez. |
| **NFR-11** | **Escalabilidad** | El backend debe cachear el `access_token` hasta el 90 % de `expires_in` para no saturar `/v1/oauth2/token` bajo carga. |
| **NFR-12** | **Compatibilidad de navegador** | La integración debe validar `cardField.isEligible()` antes de renderizar y degradar elegantemente cuando el navegador no soporta Card Fields. |
| **NFR-13** | **Auditabilidad** | Cada transacción debe ser reconstruible a partir de los logs: CMID, `PayPal-Request-Id`, `order_id`, `invoice_id`, `custom_id`. |

---

## 9. Arquitectura de la solución

### 9.1 Diagrama lógico

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NAVEGADOR DEL COMPRADOR (zona pública)                                 │
│                                                                         │
│   Checkout HTML/JS del comercio       PayPal JavaScript SDK             │
│   ┌───────────────────────────┐       ┌───────────────────────────┐     │
│   │ - Generación del CMID     │ usa→  │ paypal.CardFields(...)    │     │
│   │ - Inyección de Fraudnet   │       │   (iframes de PAN/CVV/    │     │
│   │ - Llamadas a /api/* del   │       │    expiración/nombre)     │     │
│   │   backend del comercio    │       │ Desafío 3DS (modal)       │     │
│   │ - Render de UI (meses,    │       └─────────────┬─────────────┘     │
│   │   tokens guardados)       │                     │ HTTPS directo     │
│   └─────────────┬─────────────┘                     │ a dominios PayPal │
│                 │ HTTPS /api/*                      │                   │
└─────────────────┼─────────────────────────────────  ┼───────────────────┘
                  ↓                                   ↓
┌──────────────────────────────────┐       ┌───────────────────────────────┐
│  BACKEND DEL COMERCIO (privado)  │       │  API REST de PayPal           │
│                                  │       │                               │
│  - PAYPAL_CLIENT_ID              │ HTTPS │  api-m.sandbox.paypal.com     │
│  - PAYPAL_CLIENT_SECRET ←────────┼──────→│  api-m.paypal.com (Live)      │
│  - PAYPAL_MERCHANT_ID            │       │                               │
│  - access_token (en memoria)     │       │  /v1/oauth2/token             │
│                                  │       │  /v2/checkout/orders          │
│  Endpoints expuestos al frontend │       │  /v2/checkout/orders/{id}/    │
│  (ejemplos):                     │       │     capture                   │
│  - GET    /api/token             │       │  /v3/vault/payment-tokens     │
│  - POST   /api/orders            │       │  /v1/credit/calculated-       │
│  - POST   /api/orders/:id/       │       │     financing-options         │
│           capture                │       │  /v1/risk/transaction-        │
│  - GET    /api/orders/:id        │       │     contexts                  │
│  - GET    /api/vault/            │       │                               │
│           payment-tokens         │       │                               │
│  - DELETE /api/vault/            │       │                               │
│           payment-tokens/:id     │       │                               │
│  - POST   /api/credit/           │       │                               │
│           financing-options      │       │                               │
│  - POST   /api/stc/:cmid         │       │                               │
└──────────────────────────────────┘       └───────────────────────────────┘
```

### 9.2 Reglas no negociables de la arquitectura

1. **`PAYPAL_CLIENT_SECRET` reside únicamente en variables de entorno del backend.** Jamás se versiona, jamás se envía al navegador.
2. **El navegador nunca llama directamente a `api-m.paypal.com`** para operaciones de negocio. Toda comunicación con la API REST pasa por el backend del comercio, que actúa como proxy autenticado.
3. **El navegador nunca recibe el `access_token`.** Recibe solo `clientId` (público) e `id_token` (token específico para inicializar el SDK).
4. **El PAN y el CVV nunca tocan el backend del comercio.** Card Fields los aísla en `<iframe>` del dominio de PayPal.
5. **Los datos de carrito, comprador y dirección de envío nunca son hardcoded en el código del frontend.** Provienen de la sesión autenticada y del estado del carrito en el backend.

### 9.3 Frontera de seguridad por asset

| Asset | Frontend | Backend | API PayPal |
|-------|:-------:|:------:|:---------:|
| `CLIENT_ID` | Sí | Sí | — |
| `CLIENT_SECRET` | **No** | **Sí (env)** | — |
| `MERCHANT_ID` | **No** | **Sí (env)** | — |
| `access_token` | **No** | Sí (memoria) | — |
| `id_token` | Sí (al SDK) | Sí | — |
| PAN / CVV | **iframe PayPal** | **No** | Sí |
| `PAYMENT_METHOD_TOKEN` | Sí (referencia) | Sí | Sí |
| `CMID` | Sí (genera) | Sí (recibe en body) | Sí (header) |

### 9.4 Patrón arquitectónico: Backend-for-Frontend (BFF) sobre PayPal

El backend del comercio implementa el patrón **Backend-for-Frontend** sobre la API REST de PayPal. Los endpoints `/api/*` no son una API genérica; existen para las necesidades específicas del checkout y custodian secretos, idempotencia y headers de correlación que el frontend no debe manejar.

---

## 10. Prerrequisitos y configuración del entorno

### 10.1 Habilitaciones comerciales requeridas

Antes de iniciar la implementación, el comercio debe tener activadas en su cuenta de PayPal:

| Capacidad | Aplica a |
|-----------|----------|
| **ACDC con Card Fields** | Procesamiento de tarjetas mediante el SDK. |
| **Vault v3** | Tokenización de métodos de pago. |
| **Installments (Buyer / Seller financed)** | Cobro a meses (MSI y MCI) en el mercado destino. |
| **Chargeback Protection (CBP)** | Activación de 3DS Risk Initiated. |
| **Fraudnet + Set Transaction Context** | Acceso al endpoint `/v1/risk/transaction-contexts`. |

### 10.2 Credenciales y configuración del backend

| Variable de entorno | Origen | Visibilidad |
|--------------------|--------|-------------|
| `PAYPAL_CLIENT_ID` | PayPal Developer Dashboard → app del comercio. | Pública (puede ir al frontend). |
| `PAYPAL_CLIENT_SECRET` | PayPal Developer Dashboard → app del comercio. | **Secreta — solo backend.** |
| `PAYPAL_MERCHANT_ID` | Perfil de la cuenta merchant en PayPal. | Privada — solo backend (requerida para STC). |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` (Sandbox) · `https://api-m.paypal.com` (Live). | Privada. |

> **OBLIGATORIO:** Las credenciales de Sandbox y Live son distintas. `PAYPAL_API_BASE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` y `PAYPAL_MERCHANT_ID` deben corresponder al **mismo entorno**. Una mezcla produce `401 Unauthorized` en la primera llamada a OAuth.

### 10.3 Requisitos del entorno

- **TLS / HTTPS obligatorio en producción.** Card Fields y Fraudnet no operan sobre HTTP.
- **Content Security Policy (CSP):** debe permitir como mínimo:
  - `script-src https://www.paypal.com https://www.paypalobjects.com https://c.paypal.com`
  - `frame-src https://www.paypal.com`
  - `connect-src https://api-m.paypal.com https://api-m.sandbox.paypal.com`
- **Soporte de Web Crypto API** en el navegador (para `crypto.randomUUID()`). Para soportar navegadores legacy, implementar fallback (ver §12).

---

# Parte III — Diseño detallado

## 11. Autenticación OAuth2 y emisión del `id_token`

El backend del comercio es el único componente autorizado para hablar OAuth2 con PayPal. El propósito de este paso es obtener simultáneamente:

- Un **`access_token`** para que el backend llame a la API REST de PayPal.
- Un **`id_token`** que el backend reenvía al navegador para inicializar el SDK.

### 11.1 Request

```http
POST {PAYPAL_API_BASE}/v1/oauth2/token
Authorization: Basic <BASE64(CLIENT_ID:CLIENT_SECRET)>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&response_type=id_token
```

> **OBLIGATORIO:** `response_type=id_token` debe estar presente. Sin él, la respuesta no incluye el `id_token` necesario para el SDK del frontend.

### 11.2 Response (campos relevantes)

```json
{
  "access_token": "<ACCESS_TOKEN>",
  "id_token": "<ID_TOKEN>",
  "expires_in": 32400,
  "token_type": "Bearer",
  "app_id": "<APP_ID>",
  "scope": "https://api.paypal.com/v1/payments/.* ..."
}
```

### 11.3 Caché del `access_token`

| Práctica | Justificación |
|----------|--------------|
| Cachear el `access_token` en memoria del proceso del backend hasta el **90 % de `expires_in`** y refrescarlo proactivamente. | Evita llamadas innecesarias a `/v1/oauth2/token` y reduce latencia en el camino crítico de Create Order. |
| **No** persistir el `access_token` en disco, base de datos ni logs. | Token Bearer con poder transaccional; su exposición compromete la cuenta. |
| Refrescar inmediatamente ante un `401` de cualquier llamada y reintentar **una vez**. | Cubre el edge case de token revocado por rotación de credenciales. |

### 11.4 Endpoint expuesto al frontend

El backend expone una ruta que entrega al frontend **únicamente** los datos seguros:

```http
GET /api/token
→ 200 OK
{
  "clientId": "<PAYPAL_CLIENT_ID>",
  "idToken": "<ID_TOKEN>"
}
```

> **ADVERTENCIA:** Este endpoint **nunca** debe devolver el `access_token`. Si por error se entrega al navegador, cualquier visitante puede operar la cuenta de PayPal del comercio.

### 11.5 Implementación de referencia (Node.js)

```javascript
async function generateAccessToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${process.env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials&response_type=id_token"
  });

  if (!response.ok) {
    throw new Error(`OAuth failed: ${response.status} ${await response.text()}`);
  }

  return response.json(); // { access_token, id_token, expires_in, ... }
}
```

---

## 12. Generación del Client Metadata ID (CMID)

El **CMID** es el primer dato que se materializa cuando el navegador inicializa el checkout. Es un **identificador único alfanumérico de hasta 32 caracteres sin guiones** que actúa como hilo de correlación entre cuatro componentes:

1. El campo `"f"` del script de configuración de **Fraudnet**.
2. El atributo `data-client-metadata-id` del script del **SDK de PayPal**.
3. La URL del endpoint de **STC** (`/v1/risk/transaction-contexts/{merchant_id}/{cmid}`).
4. El header `PayPal-Client-Metadata-Id` enviado al **Create Order** y al **Capture Order**.

Este orden no es accidental: la sesión de Fraudnet, las señales recolectadas por el SDK, el contexto de STC y la transacción se vinculan exclusivamente porque comparten el mismo CMID.

### 12.1 Reglas de ciclo de vida

| Regla | Detalle |
|-------|---------|
| **Único por sesión de checkout** | Se genera **una sola vez** al inicializar la página del checkout. |
| **Persistente entre reintentos** | Si el comprador falla un pago y reintenta dentro de la misma sesión, el CMID **no** se regenera. Tampoco se recarga Fraudnet. |
| **Persistente entre métodos de pago** | Si el comprador alterna entre tarjeta nueva y tarjeta guardada en la misma sesión, el CMID se conserva. |
| **Se regenera en transacción nueva** | Solo después de que la transacción anterior fue **completada o cancelada definitivamente** se genera un nuevo CMID y se recarga Fraudnet. |
| **Se propaga server-side por el backend** | El frontend lo entrega al backend en el body de Create Order/Capture Order; el backend lo reenvía como header HTTP a PayPal. |

### 12.2 Implementación de referencia

La implementación recomendada es un UUID v4 sin guiones, que ocupa los 32 caracteres disponibles y ofrece la mayor entropía posible dentro del límite. Otras estrategias (timestamp + sufijo aleatorio, ULID truncado, hash determinista de la sesión) son técnicamente válidas siempre que el resultado:

- Tenga entre **1 y 32 caracteres**.
- Contenga únicamente caracteres alfanuméricos.
- Sea único por sesión de checkout.

```javascript
function generateCMID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, ""); // 32 caracteres hex
  }
  // Fallback para entornos sin Web Crypto API
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Al inicializar el checkout:
const cmid = generateCMID(); // ej. "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
```

> **NOTA:** Aunque el contrato de PayPal acepta hasta 32 caracteres, usar identificadores de longitud máxima (UUID v4 sin guiones) es la recomendación: maximiza la unicidad y elimina ambigüedades sobre el rango aceptado por la API.

### 12.3 Validación

El CMID debe cumplir:

- Longitud entre **1 y 32 caracteres** (máximo inclusivo).
- Únicamente caracteres alfanuméricos.
- Sin guiones, sin separadores, sin espacios.

```javascript
const isValidCMID = (cmid) =>
  typeof cmid === "string" &&
  cmid.length >= 1 &&
  cmid.length <= 32 &&
  /^[0-9a-zA-Z]+$/.test(cmid);
```

---

## 13. Integración de Fraudnet

Fraudnet es el primer servicio de riesgo que se inicializa en el navegador, **inmediatamente después** de generar el CMID y **antes** de cualquier llamada al backend o al SDK. Recopila device fingerprinting, señales de comportamiento del navegador y telemetría de sesión que PayPal Risk usa para evaluar la transacción.

### 13.1 Composición

Fraudnet se implementa con **dos** elementos `<script>` inyectados en el DOM:

#### 13.1.1 Script de configuración (JSON)

```html
<script type="application/json"
        fncls="fnparams-dede7cc5-15fd-4c75-a9f4-36c430ee3a99">
{
  "f": "<CMID>",
  "s": "<NOMBRE_CORTO_DEL_MERCHANT>_<MERCHANT_ID>_ACDC"
}
</script>
```

| Atributo / campo | Valor |
|------------------|-------|
| `type` | `application/json` (constante). |
| `fncls` | `fnparams-dede7cc5-15fd-4c75-a9f4-36c430ee3a99` (constante; identificador de configuración de Fraudnet). |
| `"f"` | El CMID generado en §12 — identificador alfanumérico de hasta 32 caracteres sin guiones. |
| `"s"` | Identificador del comercio y producto. Formato fijo: `<NOMBRE_CORTO_DEL_MERCHANT>_<MERCHANT_ID>_<PRODUCTO>`. Para Card Fields el producto es siempre `ACDC`. |

#### 13.1.2 Script de la librería

```html
<script type="text/javascript" src="https://c.paypal.com/da/r/fb.js"></script>
```

> **OBLIGATORIO:** El orden importa. El script JSON de configuración debe estar presente en el DOM **antes** de que `fb.js` se ejecute. Inyectar primero la configuración, luego la librería.

### 13.2 Implementación dinámica

```javascript
let fraudnetLoaded = false;

function loadFraudnet({ cmid, merchantShortName, merchantId }) {
  if (fraudnetLoaded) return;
  fraudnetLoaded = true;

  const config = document.createElement("script");
  config.type = "application/json";
  config.setAttribute("fncls", "fnparams-dede7cc5-15fd-4c75-a9f4-36c430ee3a99");
  config.textContent = JSON.stringify({
    f: cmid,
    s: `${merchantShortName}_${merchantId}_ACDC`
  });
  document.body.appendChild(config);

  const lib = document.createElement("script");
  lib.type = "text/javascript";
  lib.src = "https://c.paypal.com/da/r/fb.js";
  document.body.appendChild(lib);
}
```

### 13.3 Reglas operativas

| Regla | Detalle |
|-------|---------|
| **Una sola carga por sesión de checkout.** | Repetir la inyección invalida la sesión de Fraudnet y produce señales inconsistentes. |
| **Cubre nueva tarjeta y tarjeta guardada.** | La misma sesión de Fraudnet aplica a ambos flujos; no recargar al cambiar de método de pago. |
| **No recargar tras un intento fallido.** | El reintento dentro de la misma sesión debe usar la misma carga de Fraudnet y el mismo CMID. |
| **Recargar solo en transacción nueva.** | Después de una transacción completada o cancelada definitivamente, generar nuevo CMID y volver a invocar `loadFraudnet`. |
| **CSP-friendly.** | El origen `https://c.paypal.com` debe estar en `script-src` de la Content Security Policy del sitio. |

---

## 14. Set Transaction Context (STC)

STC permite al comercio enviar **contexto del comprador** a PayPal Risk **antes** de cada Create Order. PayPal lo correlaciona con la sesión de Fraudnet (mediante el CMID) para una evaluación de riesgo pre-transaccional. La operación es **no bloqueante**: cualquier error debe loguearse pero **nunca** detener el flujo de checkout.

### 14.1 Endpoint

```http
PUT {PAYPAL_API_BASE}/v1/risk/transaction-contexts/<MERCHANT_ID>/<CMID>
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

| Componente de la URL | Origen |
|---------------------|--------|
| `<MERCHANT_ID>` | Variable de entorno `PAYPAL_MERCHANT_ID`. |
| `<CMID>` | El CMID generado en §12 para esta sesión. |

### 14.2 Body — set genérico para Retail

```json
{
  "additional_data": [
    { "key": "sender_account_id",   "value": "<ID_DEL_COMPRADOR_EN_LA_PLATAFORMA_DEL_COMERCIO>" },
    { "key": "sender_first_name",   "value": "<NOMBRE_DEL_COMPRADOR>" },
    { "key": "sender_last_name",    "value": "<APELLIDO_DEL_COMPRADOR>" },
    { "key": "sender_email",        "value": "<EMAIL_DEL_COMPRADOR>" },
    { "key": "sender_phone",        "value": "<TELEFONO_SOLO_DIGITOS>" },
    { "key": "sender_country_code", "value": "<PAIS_ISO_ALPHA2>" },
    { "key": "sender_create_date",  "value": "<FECHA_DE_ALTA_DEL_USUARIO>" },
    { "key": "highrisk_txn_flag",   "value": 0 },
    { "key": "vertical",            "value": "<VERTICAL_DEL_NEGOCIO>" },
    { "key": "cd_string_one",       "value": "<NIVEL_DE_CONFIANZA_DEL_USUARIO>" }
  ]
}
```

### 14.3 Referencia de campos

| Campo | Tipo | Descripción | Valores aceptados |
|-------|------|-------------|-------------------|
| `sender_account_id` | string | Identificador único del comprador en la plataforma del comercio. | Alfanumérico estable entre sesiones. |
| `sender_first_name` | string | Nombre registrado del comprador. | Alfanumérico. |
| `sender_last_name` | string | Apellido registrado del comprador. | Alfanumérico. |
| `sender_email` | string | Email validado del comprador. | Formato RFC 5322. |
| `sender_phone` | string | Teléfono del comprador, **solo dígitos**, sin formato. | `[0-9]+` |
| `sender_country_code` | string | País del comprador en ISO 3166-1 Alpha-2. | `MX`, `US`, `BR`, etc. |
| `sender_create_date` | string | Fecha de alta del usuario en la plataforma del comercio. | Formatos aceptados: `yyyy-mm-ddThh:mm:ss.000-00:00`, `yyyy-mm-ddThh:mm:ss.0000000Z`, `yyyy-mm-ddThh:mm:ss+00:00`, `yyyy-mm-ddThh:mm:ssZ`, `yyyy-mm-dd`, `yyyymmdd`. |
| `highrisk_txn_flag` | **number** | Indica si la transacción es de alto riesgo (gift cards, electrónicos, etc.). | `0` = normal, `1` = alto riesgo. **No es string.** |
| `vertical` | string | Vertical del negocio. | `Retail`, `Travel`, `Gaming`, etc. (consultar industry pack con el Integration Engineer). |
| `cd_string_one` | string | Nivel de confianza del comprador asignado por la plataforma. | `"1"` confiable / `"0"` desconocido / `"2"` no confiable. |

> **NOTA — Industry packs:** El set anterior es el genérico para Retail. Verticales como Travel, OTAs, Financial Services, Gaming y plataformas reguladas requieren campos adicionales específicos. Solicitar el industry pack correspondiente al Integration Engineer asignado.

### 14.4 Manejo de respuesta — comportamiento no bloqueante

| Status HTTP | Significado | Acción del frontend/backend |
|------------:|-------------|------------------------------|
| `200` | OK. Contexto registrado. | Continuar con Create Order. |
| `400` | Body inválido (tipo de campo o formato incorrecto). | Loguear el error con detalle, **continuar** con Create Order. |
| `401` | Sin permisos o `access_token` expirado. | Refrescar token, loguear, **continuar** con Create Order. |
| `5xx` | Error interno de PayPal. | Loguear, **continuar** con Create Order. |

> **OBLIGATORIO:** STC nunca puede bloquear el checkout. Una falla de STC reduce la calidad de la evaluación de riesgo pero **no** impide procesar la transacción.

### 14.5 Implementación de referencia

#### 14.5.1 Backend (Node.js)

```javascript
app.post("/api/stc/:cmid", async (req, res) => {
  try {
    const { cmid } = req.params;
    const { access_token } = await generateAccessToken();

    const response = await fetch(
      `${process.env.PAYPAL_API_BASE}/v1/risk/transaction-contexts/${process.env.PAYPAL_MERCHANT_ID}/${cmid}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          additional_data: buildAdditionalDataFromSession(req)
        })
      }
    );

    res.status(200).json({ success: response.ok, status: response.status });
  } catch (err) {
    console.warn("STC failed (non-blocking):", err);
    res.status(200).json({ success: false }); // No bloquear el checkout
  }
});
```

#### 14.5.2 Frontend

```javascript
async function callSTC(cmid) {
  try {
    await fetch(`/api/stc/${cmid}`, { method: "POST" });
  } catch (err) {
    console.warn("STC could not complete (non-blocking):", err);
  }
}
```

> **OBLIGATORIO:** STC se llama **antes** de **cada** Create Order, sin distinción del método de pago (tarjeta nueva o tarjeta guardada).

---

## 15. Carga del JavaScript SDK de PayPal

Con el CMID generado, Fraudnet inyectado y el `id_token` obtenido del backend, el siguiente paso es cargar el SDK de PayPal en el navegador. La carga del SDK debe ocurrir **después** de §12, §13 y la obtención de `clientId` + `idToken` (§11.4).

### 15.1 Construcción de la URL del SDK

```javascript
const url = new URL("https://www.paypal.com/sdk/js");
url.searchParams.set("client-id", clientId);
url.searchParams.set("currency", "<MONEDA_ISO_4217>");
url.searchParams.set("locale", "<LOCALE_BCP47>");
url.searchParams.set("components", "card-fields");
```

| Parámetro | Valor | Notas |
|-----------|-------|-------|
| `client-id` | `<PAYPAL_CLIENT_ID>` | Recibido del backend en `GET /api/token`. |
| `currency` | `MXN`, `USD`, `BRL`, etc. | Moneda principal del checkout en ISO 4217. |
| `locale` | `es_MX`, `en_US`, `pt_BR`, etc. | Idioma de la UI del SDK. Formato BCP-47 con guion bajo. |
| `components` | `card-fields` | Componente a cargar. Para esta solución, **únicamente** `card-fields`. |

### 15.2 Atributos del `<script>` del SDK

```javascript
const script = document.createElement("script");
script.src = url.toString();
script.setAttribute("data-sdk-client-token", idToken);
script.setAttribute("data-client-metadata-id", cmid);

script.onload = () => {
  renderCardFields(); // §16
};

document.body.appendChild(script);
```

| Atributo | Valor | Función |
|----------|-------|---------|
| `data-sdk-client-token` | `<ID_TOKEN>` recibido en §11.4. | Inicializa el SDK con la sesión autenticada del comercio. Habilita Vault (listado de tokens guardados). |
| `data-client-metadata-id` | El CMID generado en §12. | Vincula la sesión del SDK con Fraudnet, STC y los headers de Create Order/Capture Order. |

> **OBLIGATORIO:** El `data-client-metadata-id` debe ser exactamente el mismo valor que se usó en el campo `"f"` de Fraudnet (§13) y que se usará en la URL de STC (§14) y en el header `PayPal-Client-Metadata-Id` de los pasos siguientes. Cualquier divergencia rompe la correlación de riesgo.

### 15.3 Validación de elegibilidad

Tras la carga del SDK, antes de renderizar Card Fields, validar:

```javascript
const cardField = paypal.CardFields({ /* configuración — §16, §18, §20 */ });

if (!cardField.isEligible()) {
  // El navegador del comprador no soporta Card Fields.
  // Mostrar un mensaje explícito y, si aplica, ofrecer un método de pago alternativo
  // del comercio (no relacionado con PayPal).
  return;
}
```

---

## 16. Estructura HTML y estilos de Card Fields

### 16.1 Contenedores del DOM

Card Fields requiere un `<div>` vacío por cada campo del formulario de tarjeta. Los selectores que se pasan a `.render()` deben coincidir exactamente con los `id` del DOM.

```html
<div id="card-number-field-container"></div>
<div id="card-expiry-field-container"></div>
<div id="card-cvv-field-container"></div>
<div id="card-name-field-container"></div>

<select id="installments-select">
  <option value="">Sin meses</option>
</select>

<label>
  <input type="checkbox" id="vault" />
  Guardar tarjeta para futuras compras
</label>

<button id="card-field-submit" type="button">Pagar</button>

<div id="payment-result" role="status" aria-live="polite"></div>
```

### 16.2 Renderizado

```javascript
function renderCardFields() {
  const cardField = paypal.CardFields({
    style: styleObject,           // §16.4
    createOrder: createOrderFn,   // §17
    onApprove: onApproveFn,       // §20
    onError: onErrorFn,
    installments: installmentsBlock // §18
  });

  if (!cardField.isEligible()) return;

  cardField.NumberField().render("#card-number-field-container");
  cardField.ExpiryField().render("#card-expiry-field-container");
  cardField.CVVField().render("#card-cvv-field-container");
  cardField.NameField().render("#card-name-field-container");

  document.getElementById("card-field-submit").addEventListener("click", () => {
    submitWithSelectedInstallments(cardField); // §18
  });
}
```

### 16.3 Capa 1 — CSS del contenedor

El `<div>` que aloja cada iframe vive en el dominio del comercio. Su CSS controla **dimensiones, borde y layout** (alto, padding externo, márgenes, ancho relativo, etc.). PayPal publica un stylesheet de referencia que puede usarse como punto de partida:

```html
<link rel="stylesheet"
      href="https://www.paypalobjects.com/webstatic/en_US/developer/docs/css/cardfields.css">
```

Cualquier propiedad CSS estándar aplica a esta capa porque el `<div>` está en el DOM del comercio.

### 16.4 Capa 2 — `styleObject` del SDK

El `<input>` real donde el usuario escribe está dentro del `<iframe>` de PayPal. El CSS del comercio **no** puede alcanzarlo. La única vía para estilizarlo es el objeto `style` que se pasa al constructor de `paypal.CardFields`:

```javascript
const styleObject = {
  input: {
    "font-size": "14px",
    "font-family": "system-ui, sans-serif",
    "color": "<COLOR_TEXTO_NORMAL>"
  },
  ".invalid": {
    "color": "<COLOR_TEXTO_INVALIDO>"
  },
  ":focus": {
    "color": "<COLOR_TEXTO_FOCUS>"
  },
  ":hover": {
    "color": "<COLOR_TEXTO_HOVER>"
  }
};
```

#### 16.4.1 Selectores soportados

| Selector | Estado |
|----------|--------|
| `input` | Estado base del campo. |
| `.invalid` | El valor no pasa la validación interna del SDK. |
| `:focus` | El campo tiene el foco. |
| `:hover` | El cursor está sobre el campo. |

#### 16.4.2 Propiedades CSS permitidas dentro del iframe

`color`, `font`, `font-family`, `font-size`, `font-size-adjust`, `font-stretch`, `font-style`, `font-variant`, `font-variant-alternates`, `font-variant-caps`, `font-variant-east-asian`, `font-variant-ligatures`, `font-variant-numeric`, `font-weight`, `line-height`, `letter-spacing`, `opacity`, `outline`, `text-shadow`, `transition`, `padding`, `padding-top`, `padding-right`, `padding-bottom`, `padding-left`.

Cualquier otra propiedad es ignorada silenciosamente por el SDK.

> **NOTA — Accesibilidad (NFR-10):** No usar color como único indicador de invalidez. Acompañar siempre con texto y/o icono para usuarios con baja visión o daltonismo. Asociar mensajes de error mediante `aria-live="polite"` y vincular labels con sus inputs.

---

## 17. Creación y captura de órdenes

El backend del comercio expone dos rutas que actúan como proxies autenticados hacia la API REST de PayPal:

| Ruta del backend (sugerida) | API de PayPal | Propósito |
|------------------------------|---------------|-----------|
| `POST /api/orders` | `POST /v2/checkout/orders` | Crear la orden con `intent: "CAPTURE"`. |
| `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/{id}/capture` | Ejecutar el cobro real. |
| `GET /api/orders/:id` | `GET /v2/checkout/orders/{id}` | Consultar estado (necesario en flujos con tarjeta guardada que pueden auto-capturar). |

### 17.1 Headers HTTP obligatorios

| Header | Create Order | Capture Order | Descripción |
|--------|:-----------:|:-------------:|-------------|
| `Authorization: Bearer <ACCESS_TOKEN>` | Sí | Sí | Token Bearer obtenido en §11. |
| `Content-Type: application/json` | Sí | Sí | El body es JSON. |
| `PayPal-Request-Id: <UUID>` | Sí | Sí | **Idempotencia.** El **mismo UUID** debe usarse para Create Order y para su Capture asociado. Generar uno nuevo por **transacción nueva**, no por cada request. |
| `PayPal-Client-Metadata-Id: <CMID>` | Sí | Sí | Vincula la transacción con Fraudnet y STC. Mismo CMID que en `"f"` de Fraudnet y en la URL de STC. |

> **OBLIGATORIO — Idempotencia (NFR-06):** Si el frontend reintenta una transacción por timeout o error de red, el backend debe reutilizar el mismo `PayPal-Request-Id`. Esto previene órdenes y capturas duplicadas. Un nuevo UUID solo corresponde a una **transacción nueva**.

### 17.2 Create Order — payload completo (tarjeta nueva con Vault)

```json
{
  "intent": "CAPTURE",
  "application_context": {
    "brand_name": "<NOMBRE_VISIBLE_DEL_COMERCIO>",
    "locale": "<LOCALE_BCP47>",
    "shipping_preference": "SET_PROVIDED_ADDRESS",
    "user_action": "PAY_NOW",
    "return_url": "<URL_DE_RETORNO_REAL_DEL_COMERCIO>",
    "cancel_url": "<URL_DE_CANCELACION_REAL_DEL_COMERCIO>"
  },
  "payer": {
    "email_address": "<EMAIL_DEL_COMPRADOR>",
    "name": {
      "given_name": "<NOMBRE_DEL_COMPRADOR>",
      "surname":    "<APELLIDO_DEL_COMPRADOR>"
    },
    "phone": {
      "phone_type": "MOBILE",
      "phone_number": {
        "national_number": "<TELEFONO_SOLO_DIGITOS>"
      }
    }
  },
  "purchase_units": [
    {
      "invoice_id":  "<INVOICE_ID_UNICO_DEL_COMERCIO>",
      "custom_id":   "<ORDER_ID_INTERNO_DEL_COMERCIO>",
      "description": "<DESCRIPCION_BREVE_DEL_PEDIDO>",
      "amount": {
        "currency_code": "<MONEDA_ISO_4217>",
        "value":         "<TOTAL_DEL_CARRITO>",
        "breakdown": {
          "item_total": { "currency_code": "<MONEDA>", "value": "<SUMA_UNIT_AMOUNT_X_QTY>" },
          "tax_total":  { "currency_code": "<MONEDA>", "value": "<SUMA_TAX_X_QTY>" },
          "shipping":   { "currency_code": "<MONEDA>", "value": "<COSTO_DE_ENVIO>" },
          "discount":   { "currency_code": "<MONEDA>", "value": "<DESCUENTO_APLICADO>" }
        }
      },
      "items": [
        {
          "name":        "<NOMBRE_DEL_PRODUCTO>",
          "description": "<DESCRIPCION_DEL_PRODUCTO>",
          "sku":         "<SKU_DEL_CATALOGO>",
          "quantity":    "<CANTIDAD>",
          "unit_amount": { "currency_code": "<MONEDA>", "value": "<PRECIO_UNITARIO_SIN_IMPUESTOS>" },
          "tax":         { "currency_code": "<MONEDA>", "value": "<IMPUESTO_POR_UNIDAD>" },
          "category":    "PHYSICAL_GOODS"
        }
      ],
      "shipping": {
        "name":    { "full_name": "<NOMBRE_COMPLETO_DEL_DESTINATARIO>" },
        "address": {
          "address_line_1": "<CALLE_Y_NUMERO>",
          "address_line_2": "<COLONIA_O_REFERENCIA>",
          "admin_area_2":   "<CIUDAD_O_MUNICIPIO>",
          "admin_area_1":   "<ESTADO_CODIGO>",
          "postal_code":    "<CODIGO_POSTAL>",
          "country_code":   "<PAIS_ISO_ALPHA2>"
        }
      }
    }
  ],
  "payment_source": {
    "card": {
      "attributes": {
        "customer": { "id": "<ID_DEL_USUARIO_AUTENTICADO_DEL_COMERCIO>" },
        "vault": {
          "store_in_vault": "ON_SUCCESS",
          "usage_type":     "MERCHANT",
          "customer_type":  "CONSUMER",
          "permit_multiple_payment_tokens": true
        }
      }
    }
  }
}
```

### 17.3 Justificación de cada bloque

| Bloque | Por qué es obligatorio en producción |
|--------|---------------------------------------|
| `application_context.shipping_preference: SET_PROVIDED_ADDRESS` | Indica a PayPal que use la dirección incluida en `purchase_units[].shipping`. Mejora la calidad de las señales de riesgo. |
| `application_context.return_url` / `cancel_url` | Requeridos para redirecciones del flujo 3DS cuando el banco emisor lo solicita. Deben ser URLs reales del dominio del comercio. |
| `payer.email_address`, `payer.name`, `payer.phone` | Identifican al comprador para la evaluación de riesgo y para soporte de disputas. |
| `invoice_id` | Identificador único del comercio para reconciliación contable e idempotencia lógica. Evita duplicar pedidos en reintentos. |
| `custom_id` | ID interno adicional del comercio (ej. ID de pedido en su backoffice). |
| `breakdown` + `items` | El monto total debe ser **matemáticamente consistente** con el desglose y los line items. Es requisito para Installments. |
| `items[].tax` | IVA por línea, necesario para que `tax_total` cuadre. |
| `items[].category` | `PHYSICAL_GOODS`, `DIGITAL_GOODS` o `DONATION`. Influye en el procesamiento de riesgo. |
| `shipping.address` | Requerido cuando `shipping_preference` es `SET_PROVIDED_ADDRESS`. |
| `payment_source.card.attributes.customer.id` | Vincula la tarjeta al comprador en Vault. Habilita la reutilización segura. |
| `payment_source.card.attributes.vault` | Habilita el guardado en Vault al completar el pago exitosamente. Si no se desea Vault-with-Purchase, omitir este bloque. |

### 17.4 Reglas de validación del breakdown

```
amount.value === item_total + tax_total + shipping − discount
item_total   === Σ (item.unit_amount × item.quantity) por línea
tax_total    === Σ (item.tax × item.quantity) por línea
```

Si los valores no cuadran, PayPal responde `422 UNPROCESSABLE_ENTITY` con detalle del campo inconsistente.

### 17.5 Create Order con tarjeta guardada (token)

El payload base es idéntico al de §17.2 (mismo `payer`, `purchase_units`, `breakdown`, `items`, `shipping`, `application_context`). Cambia únicamente el `payment_source`:

```json
{
  "payment_source": {
    "token": {
      "id":   "<PAYMENT_METHOD_TOKEN_DEL_VAULT>",
      "type": "PAYMENT_METHOD_TOKEN"
    }
  }
}
```

#### 17.5.1 Comportamiento de captura automática

Con `payment_source.token`, PayPal puede **auto-capturar** la orden al momento de crearla. Tras Create Order, el backend debe consultar `GET /v2/checkout/orders/{id}`:

| `status` devuelto | Acción |
|-------------------|--------|
| `COMPLETED` | La orden se auto-capturó. **No** llamar a `/capture`. |
| `APPROVED` | Captura manual requerida. Llamar a `POST /v2/checkout/orders/{id}/capture`. |

### 17.6 Capture Order

```http
POST {PAYPAL_API_BASE}/v2/checkout/orders/<ORDER_ID>/capture
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
PayPal-Request-Id: <MISMO_UUID_DE_CREATE_ORDER>
PayPal-Client-Metadata-Id: <CMID>

{}
```

La respuesta contiene `purchase_units[0].payments.captures[0]` con `id` (transaction ID), `status: "COMPLETED"`, `amount`, `create_time` y `seller_protection`.

### 17.7 Propagación del CMID al header del backend

El navegador llama únicamente al backend del comercio; el backend es quien añade los headers de PayPal. Para transportar el CMID desde el frontend hasta el header `PayPal-Client-Metadata-Id`, una convención robusta es agregarlo al body de la petición y extraerlo en el backend antes de reenviar a PayPal:

```javascript
// Frontend — dentro del callback createOrder del SDK
async function createOrderFn() {
  await callSTC(cmid); // §14

  const body = buildOrderPayload(); // §17.2
  body._cmid = cmid;                // Convención: campo de control interno

  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const order = await response.json();
  return order.id; // El SDK necesita el order_id para continuar
}
```

```javascript
// Backend — ruta POST /api/orders
app.post("/api/orders", async (req, res) => {
  const { _cmid, ...orderPayload } = req.body;
  const { access_token } = await generateAccessToken();
  const requestId = req.headers["x-request-id"] || generateRequestId();

  const response = await fetch(`${process.env.PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": requestId,
      "PayPal-Client-Metadata-Id": _cmid
    },
    body: JSON.stringify(orderPayload)
  });

  res.status(response.status).json(await response.json());
});
```

> **NOTA:** El prefijo `_` en `_cmid` es una convención que indica un campo de control interno entre frontend y backend, **no** parte del payload que viaja a PayPal. El backend lo separa antes de reenviar.

---

## 18. MSI y MCI

PayPal Installments permite ofrecer compras a meses. Existen **dos modalidades**, mutuamente identificables por el campo `total_consumer_fee`:

| Modalidad | Quién paga el cargo | `total_consumer_fee.value` | `fee_reference_id` | Etiqueta de UI sugerida |
|-----------|--------------------|---------------------------|--------------------|-------------------------|
| **MSI** (Meses Sin Intereses) | Comercio (absorbe el costo) | `"0.00"` | Generalmente opcional | "X meses sin intereses" |
| **MCI** (Meses Con Intereses) | Comprador | `> "0.00"` | **Obligatorio** | "X meses — cargo $Y \<MONEDA\>" |

> **OBLIGATORIO — Clasificación correcta:** No deducir MSI/MCI del número de meses. Siempre verificar `total_consumer_fee.value`.

```javascript
const isMSI = parseFloat(option.total_consumer_fee.value) === 0;
```

### 18.1 Existen dos vías para obtener las opciones de financiamiento

| Caso | Vía |
|------|-----|
| **Tarjeta nueva** | Callbacks `onInstallmentsRequested` y `onInstallmentsAvailable` del SDK al inicializar `paypal.CardFields`. |
| **Tarjeta guardada (token)** | Llamada server-side a `POST /v1/credit/calculated-financing-options`. |

Una solución completa implementa **ambas**.

### 18.2 Tarjeta nueva — callbacks del SDK

```javascript
const cardField = paypal.CardFields({
  // ...createOrder, onApprove, onError
  installments: {
    onInstallmentsRequested: () => ({
      financingCountryCode:     "<PAIS_ISO_ALPHA2>",
      amount:                   "<TOTAL_DEL_CARRITO>",
      currencyCode:             "<MONEDA_ISO_4217>",
      billingCountryCode:       "<PAIS_DE_FACTURACION_ISO_ALPHA2>",
      includeBuyerInstallments: true
    }),

    onInstallmentsAvailable: ({ financing_options }) => {
      const opciones = (financing_options || [])
        .filter((o) => o.product === "CARD_ISSUER_INSTALLMENTS")
        .flatMap((o) => o.qualifying_financing_options);

      opciones.forEach((opt) => {
        const term = opt.credit_financing.term;
        const isMSI = parseFloat(opt.total_consumer_fee.value) === 0;

        const label = term === 1
          ? "Pago en una sola exhibición"
          : isMSI
            ? `${term} meses sin intereses`
            : `${term} meses — cargo ${opt.total_consumer_fee.value} ${opt.total_consumer_fee.currency_code}`;

        // Guardar en el estado de UI lo necesario para el submit:
        // {
        //   term,
        //   intervalDuration: opt.credit_financing.interval_duration,
        //   feeReferenceId:   opt.fee_reference_id
        // }
      });
    },

    onInstallmentsError: (err) => { /* log + UI de fallback */ }
  }
});
```

> **Convención:** Los callbacks del SDK usan `camelCase` (`financingCountryCode`, `currencyCode`, `includeBuyerInstallments`, `intervalDuration`, `feeReferenceId`). La respuesta JSON conserva los nombres del REST (`financing_options`, `total_consumer_fee`, `credit_financing`, `fee_reference_id`).

### 18.3 Submit con installments

```javascript
async function submitWithSelectedInstallments(cardField) {
  const selected = readSelectedOptionFromUI();

  if (selected.term === 1) {
    await cardField.submit({});
    return;
  }

  await cardField.submit({
    installments: {
      term:             selected.term,
      intervalDuration: selected.intervalDuration, // "P1M" = mensual (ISO 8601)
      feeReferenceId:   selected.feeReferenceId    // OBLIGATORIO en MCI
    }
  });
}
```

> **OBLIGATORIO:** Si el plazo es `1` (pago en una sola exhibición), **no** enviar el bloque `installments`. Enviar un objeto vacío `{}` al `submit`.

### 18.4 Tarjeta guardada — `calculated-financing-options`

Cuando el comprador elige un token de Vault, los callbacks del SDK no aplican. El backend del comercio debe llamar a la API de financiamiento.

#### 18.4.1 Request

```http
POST {PAYPAL_API_BASE}/v1/credit/calculated-financing-options
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

```json
{
  "financing_country_code": "<PAIS_ISO_ALPHA2>",
  "transaction_amount": {
    "value":         "<TOTAL_DEL_CARRITO>",
    "currency_code": "<MONEDA_ISO_4217>"
  },
  "funding_instrument": {
    "type": "TOKEN",
    "token": {
      "type":                 "PAYMENT_METHOD_TOKEN",
      "payment_method_token": "<PAYMENT_METHOD_TOKEN_DEL_VAULT>"
    }
  },
  "flow_context": {
    "attributes": ["FEE_POLICY_CHARGE_CONSUMER"]
  }
}
```

> **OBLIGATORIO:** El atributo `FEE_POLICY_CHARGE_CONSUMER` en `flow_context.attributes` es necesario para que la respuesta incluya opciones MCI. Sin él, la respuesta puede contener únicamente MSI.

#### 18.4.2 Procesamiento de la respuesta

Idéntico al de tarjeta nueva: filtrar por `product === "CARD_ISSUER_INSTALLMENTS"` y clasificar con `total_consumer_fee.value`.

```javascript
const opciones = data.financing_options
  .filter((o) => o.product === "CARD_ISSUER_INSTALLMENTS")
  .flatMap((o) => o.qualifying_financing_options);
```

### 18.5 Create Order con token + installments

Cuando el comprador elige plazo `> 1` con tarjeta guardada, añadir `attributes.installments` dentro de `payment_source.token` en el payload de Create Order. **REST usa `snake_case`:**

```json
{
  "intent": "CAPTURE",
  "application_context": { /* §17.2 */ },
  "payer":               { /* §17.2 */ },
  "purchase_units":      [ /* §17.2 con breakdown e items completos */ ],
  "payment_source": {
    "token": {
      "id":   "<PAYMENT_METHOD_TOKEN>",
      "type": "PAYMENT_METHOD_TOKEN",
      "attributes": {
        "installments": {
          "term":              "<TERM_DE_MESES>",
          "interval_duration": "<INTERVAL_DURATION_ISO_8601>",
          "fee_reference_id":  "<FEE_REFERENCE_ID_DE_LA_OPCION>"
        }
      }
    }
  }
}
```

| Contexto | Formato |
|----------|---------|
| Callback del SDK (`cardField.submit`) | `camelCase` → `intervalDuration`, `feeReferenceId` |
| API REST (`payment_source.token.attributes.installments`) | `snake_case` → `interval_duration`, `fee_reference_id` |

> **OBLIGATORIO:** Mezclar formatos es la causa más frecuente de errores `UNPROCESSABLE_ENTITY` en Installments.

---

## 19. Vault — Tokenización de tarjetas

Vault almacena el método de pago de forma segura y devuelve un `PAYMENT_METHOD_TOKEN` opaco que el comercio reutiliza para cobrar en futuras transacciones sin que el comprador re-ingrese sus datos.

### 19.1 `customer.id` — identificador estable del comprador

El `customer.id` vincula los tokens de Vault a un comprador. Debe ser:

- **Estable:** el mismo identificador entre sesiones del usuario.
- **Determinista:** generable a partir del registro del usuario (no aleatorio por sesión).
- **Único por comprador:** dos compradores distintos jamás comparten `customer.id`.

> **Recomendación:** usar el identificador interno del usuario en la base de datos del comercio o un hash determinista del mismo. **Evitar** emails (cambian con el tiempo) o identificadores temporales de prueba.

### 19.2 Vault-with-Purchase

Se activa al crear la orden con `payment_source.card.attributes.vault.store_in_vault = "ON_SUCCESS"` (ver §17.2). Detalles:

| Atributo | Valor | Significado |
|----------|-------|-------------|
| `store_in_vault` | `ON_SUCCESS` | Solo guarda la tarjeta si la transacción se completa exitosamente. Tarjetas fallidas no se guardan. |
| `usage_type` | `MERCHANT` | Cobros futuros iniciados por el comercio (vs `CUSTOMER` iniciados por el comprador). |
| `customer_type` | `CONSUMER` | Persona física (vs `BUSINESS`). |
| `permit_multiple_payment_tokens` | `true` | Permite múltiples tokens para el mismo `customer.id` (varias tarjetas). |

### 19.3 Listar tokens de un comprador

```http
GET {PAYPAL_API_BASE}/v3/vault/payment-tokens?customer_id=<CUSTOMER_ID>
Authorization: Bearer <ACCESS_TOKEN>
```

#### 19.3.1 Estructura de la respuesta

```json
{
  "customer": { "id": "<CUSTOMER_ID>" },
  "payment_tokens": [
    {
      "id": "<PAYMENT_METHOD_TOKEN>",
      "payment_source": {
        "card": {
          "brand":       "<VISA | MASTERCARD | AMEX | ...>",
          "last_digits": "<ULTIMOS_4_DIGITOS>",
          "expiry":      "<YYYY-MM>",
          "name":        "<NOMBRE_EN_LA_TARJETA>"
        }
      },
      "links": [
        { "rel": "self",   "href": "..." },
        { "rel": "delete", "href": "..." }
      ]
    }
  ]
}
```

Para la UI, los campos útiles son `brand`, `last_digits` y `expiry` para mostrar líneas como "VISA ····1234 (exp. 03/27)".

### 19.4 Cobrar con un token

Ver §17.5. El payload de Create Order cambia únicamente en `payment_source.token`.

### 19.5 Eliminar un token

```http
DELETE {PAYPAL_API_BASE}/v3/vault/payment-tokens/<PAYMENT_METHOD_TOKEN>
Authorization: Bearer <ACCESS_TOKEN>
```

PayPal responde `204 No Content` en caso de éxito. El token deja de aparecer en `GET /v3/vault/payment-tokens`.

---

## 20. 3DS Risk Initiated y `liabilityShift`

3-D Secure (3DS) es un protocolo donde el banco emisor del comprador verifica su identidad. Cuando 3DS es exitoso, **la responsabilidad por contracargos fraudulentos se transfiere del comercio al banco emisor**.

### 20.1 Modalidades

| Modalidad | Quién decide cuándo lanzar 3DS | Producto requerido | Cobertura de este SDD |
|-----------|--------------------------------|---------------------|------------------------|
| **Risk Initiated** | Motor de riesgo de PayPal | Chargeback Protection (CBP) | **Cubierta.** El comercio no envía instrucciones 3DS; valida el resultado en `onApprove`. |
| **Merchant Initiated** | El comercio | Fraud Protection (FP) | **No cubierta.** El comercio configura `payment_source.card.attributes.verification` en Create Order. |

### 20.2 Flujo de 3DS Risk Initiated

```
Frontend (Card Fields)        PayPal Risk Engine             Banco emisor del comprador
        │                              │                                  │
        │  cardField.submit(...)       │                                  │
        │ ──────────────────────────→  │                                  │
        │                              │  Evalúa riesgo                   │
        │                              │  ─────────────────────────────→  │
        │                              │                                  │
        │                              │  Si banco lo requiere:           │
        │                              │ ←───── modal de autenticación ───│
        │                              │                                  │
        │                              │  Resultado de autenticación      │
        │  onApprove(data)             │                                  │
        │ ←──────────────────────────  │                                  │
        │                              │                                  │
        │  Decisión: capturar o no     │                                  │
```

### 20.3 Lógica obligatoria en `onApprove`

```javascript
async function onApprove(data) {
  // data: { orderID, liabilityShift?, ... }

  if (!data.liabilityShift) {
    // Sin desafío 3DS — el motor de riesgo no lo consideró necesario.
    await capture(data.orderID);
    return;
  }

  if (data.liabilityShift === "POSSIBLE") {
    // 3DS exitoso — el banco emisor asume responsabilidad de contracargo.
    await capture(data.orderID);
    return;
  }

  // liabilityShift presente con cualquier otro valor ("N", "U", etc.) → no capturar.
  showError("La autenticación no se completó. Intente con otro método de pago.");
}
```

### 20.4 Tabla de decisión por valor de `liabilityShift`

| Valor | Significado | Acción |
|-------|-------------|--------|
| `undefined` (ausente) | No hubo desafío 3DS. | **Capturar.** |
| `"POSSIBLE"` | 3DS exitoso. Shift al emisor. | **Capturar.** |
| `"N"` | Autenticación fallida. | **No capturar.** Mostrar error. |
| `"U"` / otros | No disponible o rechazada. | **No capturar.** Mostrar error. |

### 20.5 Trazabilidad

Loguear, para auditoría:

- `liabilityShift` recibido en `onApprove`.
- `enrollment_status` y `authentication_status` presentes en la respuesta de `GET /v2/checkout/orders/{id}` bajo `payment_source.card.authentication_result`.
- Decisión final del comercio (capturar / no capturar).

> **OBLIGATORIO (NFR-08):** No loguear PAN, CVV ni `access_token`. Loguear únicamente identificadores y resultados de 3DS.

> **OBLIGATORIO:** No forzar 3DS desde el backend bajo el modelo Risk Initiated. Mezclar Risk Initiated con instrucciones de Merchant Initiated produce comportamientos indefinidos.

---

# Parte IV — Integración y operación

## 21. Orquestación end-to-end

La integración completa se descompone en cuatro momentos. La distinción es importante porque define **qué se ejecuta una sola vez** vs **qué se ejecuta en cada intento de cobro**.

### 21.1 Momento 1 — Inicialización del checkout (una sola vez por sesión)

```
1. cmid = generateCMID()                                 [§12]
2. loadFraudnet({ cmid, merchantShortName, merchantId }) [§13]
3. { clientId, idToken } = GET /api/token                [§11]
4. (Opcional) Listar tokens guardados:
     GET /api/vault/payment-tokens?customer_id=<...>     [§19.3]
5. Cargar SDK con data-client-metadata-id = cmid         [§15]
6. Renderizar Card Fields                                 [§16, §18, §20]
```

### 21.2 Momento 2 — Antes de cada Create Order (tarjeta nueva o guardada)

```
1. await callSTC(cmid)                                   [§14]
2. Construir payload de Create Order                     [§17.2 o §17.5]
3. POST /api/orders + body._cmid = cmid                  [§17.7]
   → backend inyecta:
       PayPal-Request-Id: <UUID_DE_TRANSACCION>
       PayPal-Client-Metadata-Id: <CMID>
4. Recibir order.id
```

### 21.3 Momento 3 — Decisión de captura (en `onApprove`)

```
if (!data.liabilityShift)                  → capturar      [§20]
else if (data.liabilityShift === "POSSIBLE") → capturar
else                                       → no capturar
```

> **NOTA — Tarjeta guardada con auto-captura:** Tras Create Order con `payment_source.token`, consultar `GET /api/orders/:id` y validar el `status` (§17.5.1). No invocar `/capture` si ya está `COMPLETED`.

### 21.4 Momento 4 — Captura

```
POST /api/orders/<ORDER_ID>/capture + body._cmid = cmid
   → backend inyecta:
       PayPal-Request-Id: <MISMO_UUID_DE_CREATE_ORDER>
       PayPal-Client-Metadata-Id: <CMID>
```

### 21.5 Regla mnemotécnica

| Componente | Frecuencia |
|-----------|-----------|
| **CMID + Fraudnet** | Una vez por sesión de checkout. |
| **STC + `PayPal-Client-Metadata-Id`** | En cada intento de cobro (tarjeta nueva o guardada). |
| **`PayPal-Request-Id`** | Mismo UUID para Create Order y su Capture asociado; uno nuevo por transacción. |

---

## 22. Caso de uso especializado — BOPIS

BOPIS describe el flujo en el que el comprador paga en línea pero recoge el pedido en una **tienda física**. El pago se procesa idéntico a un flujo estándar de ACDC, pero el objeto `shipping` dentro de `purchase_units` se reemplaza con los datos del **punto de pickup**, no del comprador.

### 22.1 Convención del `full_name`

El `shipping.name.full_name` debe llevar el prefijo **`S2S `** (Ship To Store, mayúsculas, con espacio después) seguido del nombre de la tienda. Esta convención permite a PayPal Risk identificar el flujo como pickup en tienda.

### 22.2 Comparación

| Campo | Delivery (entrega a domicilio) | BOPIS (pickup en tienda) |
|-------|--------------------------------|---------------------------|
| `shipping.name.full_name` | `<NOMBRE_DEL_COMPRADOR>` | `S2S <NOMBRE_DE_LA_TIENDA>` |
| `shipping.address` | Dirección del comprador | Dirección física de la tienda |

### 22.3 Payload de ejemplo

```json
"shipping": {
  "name": {
    "full_name": "S2S <NOMBRE_DE_LA_TIENDA>"
  },
  "address": {
    "address_line_1": "<CALLE_Y_NUMERO_DE_LA_TIENDA>",
    "address_line_2": "<COLONIA_O_REFERENCIA_DE_LA_TIENDA>",
    "admin_area_2":   "<CIUDAD_O_MUNICIPIO_DE_LA_TIENDA>",
    "admin_area_1":   "<ESTADO_CODIGO>",
    "postal_code":    "<CODIGO_POSTAL_DE_LA_TIENDA>",
    "country_code":   "<PAIS_ISO_ALPHA2>"
  }
}
```

> **NOTA:** Para detalles de implementación específicos (catálogo de tiendas, validaciones de horario de pickup, integración con WMS/POS) contactar al Integration Engineer.

---

## 23. Puntos de integración (mapa de endpoints)

| Operación | Backend del comercio (sugerido) | API de PayPal |
|-----------|--------------------------------|---------------|
| Token OAuth para SDK | `GET /api/token` | `POST /v1/oauth2/token` |
| Crear orden | `POST /api/orders` | `POST /v2/checkout/orders` |
| Capturar orden | `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/{id}/capture` |
| Consultar orden | `GET /api/orders/:id` | `GET /v2/checkout/orders/{id}` |
| Listar tokens guardados | `GET /api/vault/payment-tokens?customer_id=...` | `GET /v3/vault/payment-tokens` |
| Eliminar token | `DELETE /api/vault/payment-tokens/:id` | `DELETE /v3/vault/payment-tokens/{id}` |
| Opciones de financiamiento (token) | `POST /api/credit/financing-options` | `POST /v1/credit/calculated-financing-options` |
| Set Transaction Context | `POST /api/stc/:cmid` | `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` |

---

## 24. Consideraciones de seguridad

Esta sección consolida las decisiones de seguridad dispersas a lo largo del diseño. Cada control responde a uno o varios NFR de §8.

### 24.1 Custodia de credenciales (NFR-02)

| Asset | Almacenamiento | Transmisión |
|-------|----------------|-------------|
| `PAYPAL_CLIENT_SECRET` | Variable de entorno del backend, gestionada por un secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, etc.). Nunca en código fuente. | Solo backend → `/v1/oauth2/token` codificado en `Authorization: Basic`. |
| `PAYPAL_MERCHANT_ID` | Variable de entorno del backend. | Solo backend → URL de STC y configuración de Fraudnet. |
| `access_token` | Memoria del proceso del backend. Caché con TTL inferior al `expires_in`. Nunca persistido. | Solo backend → API REST de PayPal en `Authorization: Bearer`. |
| `id_token` | Generado dinámicamente, transmitido al frontend por respuesta a `GET /api/token`. | Backend → frontend (en el cuerpo de la respuesta) → SDK (atributo `data-sdk-client-token`). |

### 24.2 Aislamiento PCI (NFR-01)

- Card Fields renderiza los inputs como iframes del dominio `paypal.com`. El PAN y el CVV nunca entran al DOM del comercio.
- El backend del comercio nunca recibe payload con PAN o CVV.
- El comercio puede certificarse bajo **SAQ A**.

### 24.3 Transporte (NFR-03)

- TLS 1.2 mínimo en producción.
- HSTS recomendado.
- Certificados con cadena de confianza válida; renovación automatizada.

### 24.4 Content Security Policy (NFR-04)

CSP mínima recomendada para el dominio del checkout:

```
script-src   'self' https://www.paypal.com https://www.paypalobjects.com https://c.paypal.com;
frame-src    https://www.paypal.com;
connect-src  'self' https://api-m.paypal.com https://api-m.sandbox.paypal.com;
img-src      'self' https://www.paypalobjects.com data:;
style-src    'self' https://www.paypalobjects.com 'unsafe-inline';
```

### 24.5 Logging y manejo de datos sensibles (NFR-08)

Permitido en logs:

- `order_id`, `capture_id`, `invoice_id`, `custom_id`, `customer.id`, `CMID`, `PayPal-Request-Id`.
- `liabilityShift`, `enrollment_status`, `authentication_status`.
- Códigos de error de PayPal y mensajes de validación.

**Prohibido** en logs:

- PAN, CVV, fecha de expiración completa, nombre del titular en formato libre.
- `access_token`, `CLIENT_SECRET`, header `Authorization` completo.
- Bodies de respuesta de Vault con datos de tarjeta sin enmascarar.

### 24.6 Validación de entrada en el backend

El backend debe validar antes de reenviar a PayPal:

- Que el `_cmid` recibido del frontend sea un identificador alfanumérico de entre 1 y 32 caracteres, sin guiones ni separadores (ver regla de validación en §12.3).
- Que el monto, moneda y breakdown del payload sean consistentes con el carrito autenticado del usuario (no confiar en valores enviados por el cliente).
- Que el `customer.id` corresponda al usuario autenticado en sesión (evitar IDOR).

---

## 25. Consideraciones operativas

### 25.1 Métricas y observabilidad

Métricas mínimas a instrumentar en producción:

| Métrica | Granularidad | Alarma sugerida |
|---------|-------------|-----------------|
| Tasa de éxito de `POST /v1/oauth2/token` | Por minuto | < 99 % en ventana de 5 min. |
| Latencia p95 de Create Order y Capture Order | Por minuto | Excede SLO interno. |
| Tasa de `liabilityShift !== "POSSIBLE"` (cuando 3DS se activó) | Por hora | Anomalía vs baseline histórico. |
| Tasa de respuesta `≠ 200` en STC | Por minuto | > 5 % en ventana de 5 min (no bloquea, pero degrada riesgo). |
| Tasa de `cardField.isEligible() === false` | Por hora | Pico inusual sugiere problema de carga del SDK o navegador no soportado. |
| Tasa de `UNPROCESSABLE_ENTITY` en Create Order | Por minuto | > 0.5 % indica bug en construcción del breakdown. |
| Inventario de Fraudnet inyectado en el DOM (instrumentación cliente) | Por sesión | Más de 2 scripts inyectados → bug. |

### 25.2 Idempotencia (NFR-06)

Estrategia recomendada para `PayPal-Request-Id`:

1. El frontend genera un UUID por **transacción nueva** y lo envía al backend en el header `X-Request-Id` (o equivalente).
2. El backend almacena temporalmente la asociación `<X-Request-Id> → <PayPal-Request-Id>` durante el ciclo de vida de la orden.
3. En reintentos, el backend reutiliza el mismo `PayPal-Request-Id`.
4. Para Capture Order, el backend usa el mismo `PayPal-Request-Id` que el Create Order asociado.

### 25.3 Tolerancia a fallos

| Servicio | Estrategia |
|---------|-----------|
| `POST /v1/oauth2/token` | Reintentar una vez tras `401/5xx`; si persiste, abortar y alertar (la integración deja de funcionar). |
| `POST /v2/checkout/orders` | Reintentar con el mismo `PayPal-Request-Id` ante `5xx` o errores de red transitorios. |
| `POST /v2/checkout/orders/{id}/capture` | Igual que Create Order. |
| `PUT /v1/risk/transaction-contexts/...` (STC) | **No** reintentar. Loguear el fallo y continuar el checkout. |
| `https://c.paypal.com/da/r/fb.js` (Fraudnet) | Si el script no carga, continuar el checkout (degradación elegante, riesgo aumenta). |

### 25.4 Rotación de credenciales

- `PAYPAL_CLIENT_SECRET`: rotación coordinada con PayPal Developer Dashboard. La rotación invalida el `access_token` cacheado; el sistema debe refrescarlo automáticamente al recibir el primer `401`.
- `PAYPAL_CLIENT_ID`: cambia muy raramente. Cualquier cambio requiere actualizar también el `data-sdk-client-token` del SDK.

### 25.5 Promoción Sandbox → Live

| Punto | Cambio |
|-------|--------|
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` → `https://api-m.paypal.com` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Credenciales de la app Live, **no** Sandbox. |
| `PAYPAL_MERCHANT_ID` | Merchant ID de la cuenta Live. |
| `application_context.return_url` / `cancel_url` | URLs reales del dominio de producción del comercio. |
| `additional_data` de STC | Datos del usuario autenticado real, no valores de prueba. |

---

# Parte V — Validación y gobierno

## 26. Estrategia de pruebas y tarjetas de Sandbox

El plan de pruebas debe ejecutarse íntegramente en el entorno Sandbox (`https://api-m.sandbox.paypal.com`) antes de la promoción a Live.

### 26.1 Reglas comunes para Sandbox

- **Fecha de expiración:** cualquier fecha futura.
- **CVV:** cualquier valor de 3 dígitos (4 dígitos para Amex).
- **Nombre del titular:** libre, **excepto** para 3DS donde aplica una regla específica (ver §26.3).

### 26.2 Tarjetas para Vault y tokenización

| Marca | Número | Notas |
|-------|--------|-------|
| Visa (Bancomer) | `4772129056533503` | Tarjeta de crédito emitida por Bancomer (México). |
| Mastercard | `5288775404117508` | Tarjeta de crédito. |
| Amex | `376680816376961` | CVV de 4 dígitos. |

#### 26.2.1 Plan de prueba sugerido

1. Pagar con la tarjeta y `vault.store_in_vault: "ON_SUCCESS"` activo.
2. Confirmar `purchase_units[0].payments.captures[0].status === "COMPLETED"`.
3. Llamar `GET /v3/vault/payment-tokens?customer_id=<CUSTOMER_ID>` y verificar el token.
4. Crear nueva orden con `payment_source.token.id = <TOKEN>` y confirmar el cobro.
5. Llamar `DELETE /v3/vault/payment-tokens/<TOKEN>`, verificar `204 No Content`.
6. Volver a listar y confirmar que el token ya no aparece.

### 26.3 Tarjetas para 3DS Risk Initiated

> **OBLIGATORIO:** Para activar 3DS en Sandbox se requieren **dos** condiciones simultáneas:
>
> 1. **Card Holder Name = `3dsuser`** (literal, exactamente, sin espacios extra).
> 2. **Número de tarjeta** de las tablas de §26.3.1 o §26.3.2.
>
> Si falta cualquiera de las dos, el motor de riesgo de PayPal **no** lanza 3DS y la transacción procesa como una compra normal sin desafío.

#### 26.3.1 Flujos Frictionless (sin modal al usuario)

| Caso | Marca | `liabilityShift` esperado | `enrollment` | `auth` | ¿Capturar? | Número |
|------|-------|---------------------------|--------------|--------|-----------|--------|
| Frictionless exitoso | Mastercard | `POSSIBLE` | Y | Y | **SÍ** | `5445492013842209` |
| Frictionless exitoso | Visa | `POSSIBLE` | Y | Y | **SÍ** | `4401331018783148` |
| Frictionless fallido | Mastercard | `N` | Y | N | NO | `5445492022569124` |
| Frictionless fallido | Visa | `N` | Y | N | NO | `4401331026683975` |
| Attempts Stand-In | Mastercard | `POSSIBLE` | Y | A | **SÍ** | `5445492038663051` |
| Attempts Stand-In | Visa | `POSSIBLE` | Y | A | **SÍ** | `4401331039804212` |
| Auth no disponible | Mastercard | `N` | Y | U | NO | `5445492048677687` |
| Auth no disponible | Visa | `N` | Y | U | NO | `4401331042569984` |
| Auth rechazada por emisor | Mastercard | `N` | Y | R | NO | `5445492055763685` |
| Auth rechazada por emisor | Visa | `N` | Y | R | NO | `4401331055071902` |
| Auth no disponible en lookup | Mastercard | `POSSIBLE` | Y | A | **SÍ** | `5445492061636883` |
| Auth no disponible en lookup | Visa | `POSSIBLE` | Y | A | **SÍ** | `4401331066329091` |

#### 26.3.2 Flujos Step-Up (con modal al usuario)

| Caso | Marca | `liabilityShift` esperado | `enrollment` | `auth` | ¿Capturar? | Número |
|------|-------|---------------------------|--------------|--------|-----------|--------|
| Step-Up exitoso | Mastercard | `POSSIBLE` | Y | Y | **SÍ** | `5445492100342725` |
| Step-Up exitoso | Visa | `POSSIBLE` | Y | Y | **SÍ** | `4401331109711123` |
| Step-Up fallido | Mastercard | `N` | Y | N | NO | `5445492119435767` |
| Step-Up fallido | Visa | `N` | Y | N | NO | `4401331117299038` |
| Step-Up no disponible | Mastercard | `N` | Y | U | NO | `5445492122987739` |
| Step-Up no disponible | Visa | `N` | Y | U | NO | `4401331128022452` |

### 26.4 Diccionario de valores

#### 26.4.1 `liabilityShift` (en `data.liabilityShift` de `onApprove`)

| Valor | Acción |
|-------|--------|
| `undefined` | Capturar — no hubo desafío 3DS. |
| `"POSSIBLE"` | Capturar — 3DS exitoso, shift al emisor. |
| `"N"` | No capturar — autenticación fallida. |
| `"U"` | No capturar — autenticación no disponible. |

#### 26.4.2 `authentication_status` (en `payment_source.card.authentication_result` de la orden)

| Valor | Significado |
|-------|-------------|
| `Y` | Autenticación exitosa y verificada. |
| `N` | Autenticación fallida. |
| `A` | Attempts — intento sin garantía completa. |
| `U` | No disponible — banco/sistema no pudo completar. |
| `R` | Rechazada explícitamente por el emisor. |

#### 26.4.3 `enrollment_status`

| Valor | Significado |
|-------|-------------|
| `Y` | Tarjeta inscrita en 3DS. |
| `N` | No inscrita. |
| `U` | Inscripción no determinable. |

### 26.5 Casos de prueba mínimos (matriz)

| ID | Caso | Resultado esperado | Cumple RF |
|----|------|-------------------|-----------|
| TC-01 | Pago con tarjeta nueva, sin 3DS, sin Vault | Captura exitosa, token NO aparece en Vault. | RF-01, RF-02 |
| TC-02 | Pago con tarjeta nueva, 3DS Frictionless exitoso | `liabilityShift = "POSSIBLE"`, captura exitosa. | RF-03 |
| TC-03 | Pago con tarjeta nueva, 3DS Step-Up exitoso | Modal aparece, captura exitosa al aprobar. | RF-03 |
| TC-04 | Pago con tarjeta nueva, 3DS Step-Up fallido | Modal aparece, NO captura, UI muestra error claro. | RF-03, RF-10 |
| TC-05 | Vault-with-Purchase | Captura exitosa, token aparece en `GET /v3/vault/payment-tokens`. | RF-04 |
| TC-06 | Pago con tarjeta guardada (token) | Captura exitosa o auto-captura, según `status`. | RF-05 |
| TC-07 | Eliminación de token | `DELETE` retorna 204, token desaparece del listado. | RF-06 |
| TC-08 | Pago a 3 MSI con tarjeta nueva | Selector muestra opción "3 meses sin intereses", captura exitosa. | RF-07 |
| TC-09 | Pago a 6 MCI con tarjeta nueva | Selector muestra cargo, captura exitosa con `fee_reference_id`. | RF-07 |
| TC-10 | Pago a 6 MSI con tarjeta guardada | `calculated-financing-options` devuelve la opción, captura exitosa. | RF-05, RF-07 |
| TC-11 | STC responde 400 | Checkout no se interrumpe; orden se crea correctamente. | RF-08 |
| TC-12 | Inspección DOM al inicializar | Exactamente 2 scripts de Fraudnet (config JSON + `fb.js`). | RF-09 |
| TC-13 | Reintento dentro de la misma sesión tras fallo | Mismo CMID, misma carga de Fraudnet. | RF-12 |
| TC-14 | BOPIS (si aplica) | `shipping.name.full_name` con prefijo `S2S `. | RF-11 |

---

## 27. Convenciones de nombres REST vs SDK

La inconsistencia entre `snake_case` (REST) y `camelCase` (SDK) es la causa más frecuente de bugs en Installments y Vault. Tabla de equivalencias:

| Concepto | API REST (`snake_case`) | SDK JavaScript (`camelCase`) |
|----------|-------------------------|------------------------------|
| Duración del intervalo de financiamiento | `interval_duration` | `intervalDuration` |
| Referencia de comisión de la opción | `fee_reference_id` | `feeReferenceId` |
| País de financiamiento | `financing_country_code` | `financingCountryCode` |
| País de facturación | `billing.country_code` (objeto) | `billingCountryCode` |
| Código de moneda | `currency_code` | `currencyCode` |
| Incluir buyer installments | (no aplica en REST) | `includeBuyerInstallments` |
| Resultado de 3DS en el callback | (no aplica en REST) | `liabilityShift` |
| Identificador de orden | `id` (en respuesta) | `orderID` (en callbacks) |

> **Regla mental:** Si el dato sale o entra de un endpoint REST, es `snake_case`. Si lo pasas a un método del objeto `paypal.*` o lo recibes en un callback, es `camelCase`.

---

## 28. Asunciones, dependencias y restricciones

### 28.1 Asunciones

| ID | Asunción |
|----|----------|
| **A-01** | El comercio dispone de un backend bajo su control donde puede custodiar `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` y emitir el `access_token`. |
| **A-02** | El comercio tiene un sistema de autenticación de usuarios que produce un `customer.id` estable y determinista por comprador. |
| **A-03** | El comercio tiene un servicio de carrito que produce un breakdown matemáticamente consistente. |
| **A-04** | El mercado destino soporta la moneda configurada y las modalidades MSI/MCI aplicables. |
| **A-05** | El comprador usa un navegador moderno con soporte de iframes, ES2017+ y CSP. La degradación para navegadores legacy se gestiona vía `cardField.isEligible()`. |
| **A-06** | La cuenta de PayPal tiene activadas las habilitaciones comerciales listadas en §10.1. |

### 28.2 Dependencias externas

| ID | Dependencia | Tipo |
|----|-------------|------|
| **D-01** | API REST de PayPal (`api-m.paypal.com`, `api-m.sandbox.paypal.com`). | Crítica — bloqueante. |
| **D-02** | JavaScript SDK de PayPal (`https://www.paypal.com/sdk/js`). | Crítica — bloqueante. |
| **D-03** | Stylesheet base de Card Fields (`https://www.paypalobjects.com/.../cardfields.css`). | Recomendada. |
| **D-04** | Script de Fraudnet (`https://c.paypal.com/da/r/fb.js`). | Recomendada — degradación elegante si no carga. |
| **D-05** | Endpoint OAuth2 (`/v1/oauth2/token`). | Crítica — sin él no hay `access_token` ni `id_token`. |
| **D-06** | Endpoint STC (`/v1/risk/transaction-contexts`). | Recomendada — no bloqueante. |

### 28.3 Restricciones

| ID | Restricción |
|----|-------------|
| **R-01** | 3DS Risk Initiated solo opera con cuentas que tengan **Chargeback Protection (CBP)** activo. Cuentas con Fraud Protection (FP) requieren la modalidad Merchant Initiated, fuera del alcance de este SDD. |
| **R-02** | El `customer.id` en Vault debe ser estable; cambiarlo invalida la asociación con tokens previamente guardados. |
| **R-03** | El CMID es único por sesión de checkout y no debe reutilizarse entre compradores ni sesiones distintas. |
| **R-04** | `PayPal-Request-Id` debe ser idempotente: el mismo UUID para Create Order y su Capture asociado; nuevo por transacción. |
| **R-05** | Los scripts de Fraudnet deben inyectarse en el orden correcto: primero la configuración JSON, luego `fb.js`. |
| **R-06** | El `data-client-metadata-id` del SDK debe coincidir exactamente con el `"f"` de Fraudnet, la URL de STC y el header de Create/Capture Order. |

---

## 29. Riesgos y mitigaciones

| ID | Riesgo | Probabilidad | Impacto | Mitigación |
|----|--------|:------------:|:-------:|------------|
| **RG-01** | Exposición de `PAYPAL_CLIENT_SECRET` por commit accidental al repositorio. | Media | Crítico | Pre-commit hooks que detecten patrones de secretos; secrets manager; revisión de seguridad obligatoria. Plan de rotación inmediata si se detecta exposición. |
| **RG-02** | Exposición de `access_token` al frontend por bug en `GET /api/token`. | Baja | Crítico | Tests automatizados que validen que la respuesta no contiene `access_token`; revisión de código obligatoria. |
| **RG-03** | Inyección múltiple de Fraudnet por bug de carga. | Media | Medio | Bandera booleana a nivel de módulo (§13.2); test de inspección DOM en QA. |
| **RG-04** | Desincronización del CMID entre Fraudnet, SDK, STC y headers. | Media | Alto (degrada riesgo) | Generar el CMID en un único punto y propagarlo por referencia; validación con regex (§12.3); test que confirma que los cuatro lugares contienen el mismo valor. |
| **RG-05** | Captura de pagos con `liabilityShift` desfavorable por bug en `onApprove`. | Baja | Crítico (contracargos) | Tests automatizados que cubran la matriz de §20.4; alarma operativa sobre tasa de captura con `liabilityShift !== "POSSIBLE"`. |
| **RG-06** | Order duplicada por reintento sin idempotencia. | Media | Alto | `PayPal-Request-Id` consistente entre reintentos (§17.1, §25.2). |
| **RG-07** | Mezcla `snake_case`/`camelCase` en Installments → `UNPROCESSABLE_ENTITY`. | Alta | Medio | Tabla de convenciones (§27); revisión de código; tests específicos para MSI y MCI. |
| **RG-08** | Carga de credenciales del entorno equivocado (Sandbox en Live o viceversa). | Baja | Crítico | Validación del prefijo del `CLIENT_ID` y del `PAYPAL_API_BASE` al arrancar el backend; alarma si hay incoherencia. |
| **RG-09** | Caída del SDK de PayPal o de Fraudnet por incidente externo. | Baja | Alto | Monitoreo activo de la disponibilidad de los dominios PayPal; mensaje de degradación al usuario; reintento controlado. |
| **RG-10** | Bloqueo del checkout por error de STC (incumplimiento de NFR-05). | Baja | Crítico | STC implementado como no bloqueante con `try/catch` y respuesta 200 garantizada al frontend (§14.5.1). Test de QA: TC-11. |
| **RG-11** | CSP demasiado restrictiva bloquea Fraudnet o SDK. | Media | Alto | CSP probada en staging; fallback de detección y mensaje claro al usuario si los scripts no cargan. |
| **RG-12** | Datos hardcoded de demo persisten en producción (`customer.id`, `additional_data` de STC, breakdown). | Media | Alto | Code review obligatorio; checklist de §30; búsqueda de strings literales sospechosos antes de cada release. |

---

## 30. Criterios de aceptación y checklist pre-producción

Antes de promover la solución a Live, todos los siguientes criterios deben cumplirse.

### 30.1 Seguridad

- [ ] `PAYPAL_CLIENT_SECRET` reside únicamente en variables de entorno del backend; nunca se incluye en código fuente versionado ni se envía al navegador.
- [ ] Archivos de configuración con credenciales (`.env`, equivalentes) excluidos del control de versiones.
- [ ] El backend solo expone `clientId` e `idToken` al frontend; nunca `access_token`.
- [ ] Logs no registran PAN, CVV, `access_token` ni headers `Authorization`.
- [ ] Content Security Policy permite `https://www.paypal.com`, `https://www.paypalobjects.com` y `https://c.paypal.com`.
- [ ] TLS 1.2+ habilitado en producción.

### 30.2 Configuración

- [ ] `PAYPAL_API_BASE` apunta a `https://api-m.paypal.com` en Live.
- [ ] `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` y `PAYPAL_MERCHANT_ID` corresponden al entorno Live.
- [ ] `application_context.return_url` y `cancel_url` son URLs reales y accesibles del dominio del comercio.
- [ ] El atributo `data-client-metadata-id` del SDK usa el CMID generado dinámicamente, no un literal.
- [ ] El parámetro `components` del SDK incluye únicamente `card-fields`.

### 30.3 Funcional

- [ ] `customer.id` proviene del usuario autenticado en la plataforma del comercio, no de un literal.
- [ ] `breakdown` e `items` reflejan el estado real del carrito y cumplen las reglas de §17.4.
- [ ] `PayPal-Request-Id`: el **mismo UUID** en Create Order y su Capture asociado; uno nuevo por transacción.
- [ ] Manejo de errores implementado en `onError` y en `onInstallmentsError`.
- [ ] La UI maneja explícitamente `liabilityShift !== "POSSIBLE"` cuando está presente.
- [ ] Los datos de `payer`, `shipping` y `purchase_units` provienen del estado del checkout, no de placeholders.

### 30.4 Riesgo

- [ ] CMID generado una sola vez por sesión de checkout.
- [ ] Fraudnet inyectado una sola vez (campo `"f"` con el CMID dinámico).
- [ ] Campo `"s"` de Fraudnet con formato `<NOMBRE_CORTO>_<MERCHANT_ID>_ACDC`.
- [ ] STC se llama antes de **cada** Create Order (tarjeta nueva y guardada).
- [ ] `additional_data` de STC proviene de la sesión autenticada del comprador.
- [ ] STC no bloquea el checkout: errores se loguean y la transacción continúa.
- [ ] Header `PayPal-Client-Metadata-Id` presente en Create Order y Capture Order, con el mismo CMID.

### 30.5 Pruebas

- [ ] Matriz de casos de prueba TC-01 a TC-14 ejecutada y verde en Sandbox.
- [ ] Inspección del DOM confirma exactamente dos scripts de Fraudnet (config + `fb.js`).
- [ ] STC con `PUT /v1/risk/transaction-contexts/...` responde 200 antes de cada Create Order.

### 30.6 Operación

- [ ] Métricas de §25.1 instrumentadas y conectadas al sistema de observabilidad.
- [ ] Alarmas configuradas para los umbrales sugeridos.
- [ ] Runbook de incidentes documentado: falla de OAuth, falla de Create Order, anomalía de `liabilityShift`.
- [ ] Plan de rotación de `CLIENT_SECRET` documentado y probado en Sandbox.

---

# Apéndices

## Apéndice A — Diagnóstico de errores frecuentes

| Síntoma | Causa más probable | Cómo diagnosticar |
|---------|--------------------|-------------------|
| `401 Unauthorized` en `/v1/oauth2/token` | `CLIENT_ID` / `CLIENT_SECRET` mal copiados o entorno cruzado (Sandbox vs Live). | Verificar que `PAYPAL_API_BASE` y las credenciales correspondan al **mismo entorno**. |
| `422 UNPROCESSABLE_ENTITY` en Create Order | `breakdown` que no cuadra con `amount.value` y/o suma de items. | Aplicar reglas de §17.4 manualmente; PayPal devuelve el campo específico inconsistente en la respuesta. |
| `422 UNPROCESSABLE_ENTITY` con installments MCI | `fee_reference_id` faltante. | En MCI (`total_consumer_fee.value > 0`) `fee_reference_id` es obligatorio en el `submit` (camelCase) o en `attributes.installments` (snake_case). |
| MSI y MCI se mezclan en la UI | Solo se mira `term`, no `total_consumer_fee`. | Usar `parseFloat(opt.total_consumer_fee.value) === 0` para clasificar. |
| `liabilityShift === "N"` y se intenta capturar | `onApprove` no valida el resultado de 3DS. | Implementar la tabla de decisión de §20.4. |
| Token guardado no aparece al listar | `customer.id` distinto entre Vault-with-Purchase y consulta. | El `customer.id` debe ser el mismo identificador estable del comprador en ambos puntos. |
| STC responde 400 | Tipo de campo incorrecto en `additional_data`. | `highrisk_txn_flag` debe ser **number** (`0` o `1`), no string. `sender_create_date` debe usar uno de los formatos permitidos (§14.3). |
| STC responde 401 | `MERCHANT_ID` incorrecto, `access_token` expirado o sin permiso de `risk/transaction-contexts`. | Verificar `PAYPAL_MERCHANT_ID`. Refrescar token. Validar habilitación con el Integration Engineer. |
| Fraudnet se inyecta múltiples veces | Falta la bandera `fraudnetLoaded`. | Implementar el patrón booleano de §13.2 a nivel de módulo. |
| `data-client-metadata-id` aparece vacío | El SDK se cargó antes de generar el CMID. | Garantizar el orden estricto: §12 → §13 → §11 → §15. |
| Funciona en Postman pero falla en el navegador | El frontend está intentando llamar a `api-m.paypal.com` directamente. | El frontend siempre va contra `/api/*` del backend; nunca directo a la API REST de PayPal. |
| Card Fields no renderiza | `cardField.isEligible()` devuelve `false` o el SDK no se cargó. | Validar `isEligible()` antes de `.render()`. Revisar la consola del navegador y la pestaña Network para confirmar la carga del script del SDK. |
| 3DS nunca se activa en Sandbox | Falta el nombre `3dsuser` o tarjeta no listada. | Cumplir simultáneamente las dos condiciones de §26.3. |

---

## Apéndice B — Limitaciones y trabajo futuro

### B.1 Limitaciones conocidas

- **3DS Merchant Initiated** no está cubierto. Comercios con Fraud Protection (FP) en lugar de Chargeback Protection (CBP) requieren una solución distinta basada en `payment_source.card.attributes.verification`.
- Las **tarjetas de prueba** y comportamientos descritos en §26 son los publicados por PayPal Sandbox al momento de redactar este SDD. PayPal puede actualizar el set de prueba; consultar la documentación oficial vigente ante discrepancias.
- Las **tarjetas de Sandbox** funcionan únicamente en el dominio Sandbox. Llamarlas contra Live produce un rechazo del banco emisor real.
- Los **industry packs de STC** (Travel, OTAs, Gaming, Financial Services, etc.) requieren campos adicionales no incluidos en el set genérico Retail de §14.2. Solicitar el pack correspondiente al Integration Engineer asignado.
- La **divergencia REST vs SDK** (`snake_case` vs `camelCase`) puede cambiar entre versiones del SDK. La versión cargada del SDK (`https://www.paypal.com/sdk/js`) es la fuente de verdad para los nombres de los callbacks.
- El **CMID** debe ser único por sesión de checkout. No reutilizar CMIDs entre compradores ni entre sesiones distintas del mismo comprador.
- Esta solución describe la integración server-to-server del comercio. **Webhooks**, reembolsos, settlement y disputas requieren un SDD complementario.

### B.2 Trabajo futuro sugerido

| Iniciativa | Descripción |
|------------|-------------|
| **Webhooks** | SDD complementario para suscripción y procesamiento de eventos asíncronos (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CUSTOMER.DISPUTE.CREATED`, etc.). |
| **Reembolsos** | Diseño del flujo de back-office para reembolsos parciales y totales (`POST /v2/payments/captures/{id}/refund`). |
| **Conciliación financiera** | Integración con reportes de PayPal y settlement para reconciliación contable. |
| **APMs adicionales** | Extensión de la solución para incluir Pay Later, Venmo o billeteras locales. |
| **Suscripciones** | Si el modelo de negocio evoluciona hacia recurrencia gestionada por PayPal Billing Plans. |
| **Industry pack** | Adopción del set extendido de `additional_data` de STC correspondiente a la vertical del comercio. |

---

*Solution Design Document para la integración de PayPal Advanced Credit and Debit Card (ACDC) con Card Fields, 3DS Risk Initiated, Installments (MSI/MCI), Vault, Fraudnet y Set Transaction Context (STC).*
