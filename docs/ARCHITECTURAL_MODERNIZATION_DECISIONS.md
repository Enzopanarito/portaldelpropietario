# Modernización arquitectónica — decisiones controladas

Fecha base: 2026-07-13  
Producción al iniciar esta fase: `a9c9838953fa20ac76ae3278fa39fc2abc8427d5`

## Reglas permanentes

- `main` y Airtable producción no se modifican desde ramas de trabajo.
- Toda fase parte de un SHA conocido y tiene una rama de respaldo.
- El motor financiero v5 y `ControlVersiones` siguen siendo la única fuente financiera oficial.
- USD y Bs. BCV no se mezclan.
- Los deploy previews deben usar datos staging o test; nunca producción.
- Cada mutación crítica debe ser idempotente y auditable.
- Ningún resultado incierto puede presentarse como completado.

## Ideas aceptadas

### Staging de Airtable

Aceptado como prioridad. El repositorio incluye:

- guardas puras para detectar configuraciones de entorno inseguras;
- un sincronizador que sanitiza nombres, teléfonos, correos, referencias y credenciales MKJ;
- modo `plan` por defecto, sin escrituras;
- reemplazo de staging únicamente con `--apply` y `STAGING_SYNC_CONFIRM=REPLACE_STAGING_ONLY`;
- respaldo completo del target antes de eliminar registros;
- verificación de conteos después de poblar;
- workflow manual protegido por el environment de GitHub `staging`.

La estructura de la base staging debe existir antes de aplicar. La vía recomendada es duplicar la estructura desde Airtable y ejecutar después el sincronizador de datos sanitizados.

### Idempotencia fuerte con Netlify Blobs

Aceptada, pero no mediante una tabla nueva de Airtable como candado principal. La fase siguiente usará escrituras condicionales (`onlyIfNew` y `onlyIfMatch`) y lecturas fuertes. Airtable conservará únicamente el espejo de auditoría cuando corresponda.

### Fotografía pública en Netlify Blobs

Aceptada. El portal público dejará de solicitar `?force=1`. La fotografía se generará server-side con motor v5, se versionará y tendrá fallback controlado. La activación será gradual y reversible.

### IA para comprobantes

Aceptada como fase posterior. Será asistente de extracción y comparación; nunca aprobará pagos. Debe incluir JSON estricto, confianza por campo, hash del archivo, detección de duplicados y aprobación humana obligatoria.

## Ideas descartadas o modificadas

### Playwright + CDP como conector principal

Descartado. El candidato de WhatsApp usa Chrome normal, extensión privada Manifest V3, Native Messaging y una aplicación Swift. Esta arquitectura limita permisos y evita exponer el navegador completo por CDP. Un `MutationObserver` podrá añadirse como evidencia complementaria dentro de la extensión, no como sustituto de las verificaciones actuales.

### Unificar `LEGACY` y `Bs BCV` en el hash mensual

Descartado porque no representan la misma operación:

- `Bs BCV` reduce exclusivamente la cuenta Bs. BCV.
- `LEGACY` aplica primero a Bs., luego a USD y finalmente puede generar saldo a favor en Bs.

Pueden producir el mismo total referencial y distinta composición por moneda. Compartir hash ocultaría una diferencia financiera real. La prueba `monthly-close-legacy-hash.test.js` documenta y protege esta semántica.

### Tabla Airtable `Registro de Idempotencia` como bloqueo principal

Descartada. Airtable no ofrece una restricción única transaccional suficiente para usarla como candado concurrente. Netlify Blobs será el mecanismo primario; Airtable podrá conservar un registro redactado para auditoría.

## Orden de ejecución

1. Aislamiento de staging y prueba reforzada del hash.
2. Idempotencia fuerte de mutaciones críticas.
3. Fotografía pública versionada en Blobs.
4. Certificación del conector WhatsApp cuando Enzo indique: `listo sigamos con WhatsApp`.
5. Validación asistida de comprobantes con IA.
