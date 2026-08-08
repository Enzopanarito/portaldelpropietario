# Consolidación VLA v7

## Objetivo

Esta entrega elimina la superposición de cálculos y parches visuales que podían mostrar saldos distintos según el momento de carga. La regla funcional es estricta: la consolidación no modifica datos financieros persistidos y debe conservar exactamente los saldos visibles antes del cambio.

## Fuentes canónicas

| Responsabilidad | Fuente canónica | Contrato |
| --- | --- | --- |
| Cálculo financiero por propietario | `vla-finance-v7.js` | `vla-balance-contract-v7` |
| DTO público | `netlify/functions/public-data-v2.js` | Campos canónicos y aliases de compatibilidad |
| Desglose en el portal | `owner-breakdown-v7.js` | `owner-breakdown-v7` |
| Reporte progresivo de pagos | `owner-payment-report-v3.js` | `progressive-v7` |
| Estado operacional | `netlify/functions/system-health.js` | Verificación canónica 15/15 |

Los edge functions `balance-fix`, `currency-balance-fix`, `accounting-health-fix` y `admin-payment-flow` permanecen en el repositorio únicamente como historial compatible. Ya no están registrados en `netlify.toml` y no participan en producción. Sus responsabilidades quedaron integradas en las fuentes canónicas correspondientes. `pwa-head` se limita a metadatos, tema y presentación de la tasa BCV; no reescribe saldos ni pagos.

## Inventario de ejecución

El repositorio conserva 126 módulos Function/soporte y 11 archivos Edge. La cantidad de archivos no equivale a rutas activas: varias versiones son fachadas de compatibilidad, helpers o workers. Las cadenas críticas vigentes quedan así:

| Ruta o proceso | Cadena canónica |
| --- | --- |
| `/api/vla/public-data` | `public-data-modern.mjs` → `public-data-v3.js` → snapshot validado → `public-data-v2.js` |
| `/api/vla/report-payment` | `public-report-payment-modern.mjs` → `public-report-payment.js` |
| `/api/vla/payment-proof-prefill` | `payment-proof-prefill-modern.mjs` → `payment-proof-prefill.js` |
| `/api/vla/monthly-close` | `monthly-close-modern.mjs` → `monthly-close.js` → `monthly-close-v4.js` |
| Health administrativo | `system-health-advanced.js` → `system-health.js` |
| Reconciliación MKJ | `access-reconciliation-*` → `_mkj_client.js` y motor de decisión existente |

Los Edge registrados se limitan a siete responsabilidades: `pwa-head`, assets premium de Admin, versión de autenticación, assets móviles del propietario, firma visual del propietario, links de Admin y endurecimiento del cierre mensual. Las cuatro capas desregistradas se conservan para trazabilidad y posible rollback, pero un gate impide reactivarlas accidentalmente.

## Invariantes financieras

- `saldoUsd` y `saldoBsRef` se calculan de forma independiente.
- `totalPagadero` suma solamente saldos positivos y nunca compensa una deuda con crédito de otra moneda.
- `saldoNetoReferencial` se conserva como información referencial separada.
- Los créditos se presentan aparte de lo pagadero.
- Ningún cambio de interfaz crea, edita o elimina movimientos, pagos, cuotas o saldos en Airtable.

## Baseline de producción protegido

| Casa | Total pagadero USD ref. | Saldo USD | Saldo Bs ref. | Neto referencial |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 55.00 | 55.00 | 0.00 | 55.00 |
| 2 | 94.57 | 0.00 | 94.57 | 94.57 |
| 3 | 141.82 | 50.00 | 91.82 | 141.82 |
| 4 | 169.23 | 70.00 | 99.23 | 169.23 |
| 5 | 176.96 | 70.00 | 106.96 | 176.96 |
| 6 | 0.00 | 0.00 | -0.49 | -0.49 |
| 7 | 70.00 | 70.00 | 0.00 | 70.00 |
| 8 | 70.00 | 70.00 | -0.03 | 69.97 |
| 9 | 0.00 | 0.00 | 0.00 | 0.00 |
| 10 | 90.24 | 0.00 | 90.24 | 90.24 |
| 11 | 50.00 | 50.00 | -294.76 | -244.76 |
| 12 | 141.82 | 50.00 | 91.82 | 141.82 |
| 13 | 111.82 | 20.00 | 91.82 | 111.82 |
| 14 | 20.00 | 20.00 | 0.00 | 20.00 |
| 15 | 158.72 | 50.00 | 108.72 | 158.72 |

La prueba `tests/vla-finance-v7.test.js` bloquea la entrega si cualquiera de estos valores cambia.

## Reporte de pagos

El portal pregunta primero si el pago fue digital o en efectivo. Para pagos digitales, analiza el comprobante y solicita únicamente campos ausentes o una corrección explícita. Zelle, Binance Pay y transferencias cripto pueden usar la fecha del reporte en Caracas cuando el comprobante no ofrece una fecha válida. El estado inicial lo asigna exclusivamente el servidor.

Los pagos en efectivo quedan en `PENDING_ADMIN_CONFIRMATION`; no modifican saldo ni acceso hasta una confirmación administrativa. Todos los reportes conservan idempotencia, detección de duplicados, almacenamiento cifrado y fallback manual.

## Observabilidad y gates

- Los reportes exitosos y fallidos emiten eventos JSON estructurados sin monto, referencia ni contenido del comprobante.
- `system-health` valida el contrato canónico, el snapshot público, las 15 casas y el cierre mensual.
- CI ejecuta pruebas unitarias, build de producción y gates críticos de navegador antes de permitir el build de Netlify.
- Los headers `x-vla-balance-contract`, `x-vla-breakdown-presentation` y `x-vla-owner-payment-flow` permiten confirmar la versión activa sin depender del DOM.
