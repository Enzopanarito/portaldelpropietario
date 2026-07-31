# Villa Los Apamates — preparación “reloj suizo”

Estado: preparado en la rama `feature/reloj-suizo-10-de-10`. No desplegar ni activar hasta completar este procedimiento.

## Resultado incluido

### Portal de propietarios

- Conserva visible la morosidad del condominio y la deuda por casa.
- Muestra vencimiento, cuenta regresiva y fecha de limitación del acceso cómodo.
- Explica que un reporte no cambia deuda ni portón hasta ser validado.
- Muestra historial completo de pagos, moneda, condición activa/cerrada y última sincronización del portón.
- Permite reportar pagos con comprobante obligatorio cuando la casa está limitada.
- Usa la misma regla configurable de vencimiento y recargo que administración, cierre y portón.

### Portal administrativo

- Centro de “Piloto automático” con interruptor maestro y confirmación explícita.
- Precarga manual del mes siguiente y edición antes de activarse.
- Separación visual entre gastos activos y programados.
- Bandeja de pagos como bandeja de excepciones: estado del análisis, confianza, datos detectados, diferencias y posibles duplicados.
- Salud del sistema ampliada para IA, cifrado, cola interna, correo, BCV, Airtable y MKJoules.

### Motores automáticos

- Precarga idempotente de gastos fijos tres días antes de terminar el mes.
- Cierre principal el día 1 a las 12:00 a. m. de Venezuela.
- Recuperación segura los días 2 y 3 si Airtable o Netlify estuvieron lentos.
- Doble simulación, huella financiera, corte de auditoría, bloqueo de escrituras y restauración verificada.
- Rotación de gastos: cierra el mes anterior y activa únicamente la precarga del nuevo mes.
- Recordatorios por correo antes del vencimiento y antes de la limitación.
- Recalculo del portón después de un pago definitivo; un reporte pendiente nunca habilita acceso.
- Análisis de comprobantes en segundo plano, recuperación horaria y aprobación solo mediante reglas determinísticas.
- Detección de duplicados por archivo, huella financiera y referencia.

## Principios de seguridad operacional

1. La IA extrae información; no decide por sí sola.
2. Solo se aprueba automáticamente una coincidencia exacta, con receptor autorizado, operación completada, moneda correcta, monto coincidente, referencia visible, fotografía financiera vigente y confianza mínima.
3. Ante datos viejos, inconsistentes o incompletos, no se cambia el portón ni se crea un pago.
4. Toda operación financiera sensible es idempotente y deja rastro.
5. El primer despliegue nace con todos los motores autónomos apagados.

## Preparación previa al único despliegue

### 1. Congelar y respaldar

- Confirmar respaldo de Git y Airtable.
- Conservar el despliegue productivo actual como punto de restauración.
- Ejecutar `npm run verify`.
- Ejecutar `npm audit --omit=dev` y bloquear la salida si aparece una vulnerabilidad alta o crítica.
- Confirmar que no existen reportes de pago pendientes ni cierres parciales.

La versión candidata del 23/07/2026 usa `@netlify/blobs` 10.7.9, que es la versión
publicada más reciente. La auditoría no reporta vulnerabilidades altas ni críticas.
Los avisos moderados restantes provienen de la telemetría transitiva de Netlify,
no tienen corrección disponible y deben volver a revisarse antes del despliegue.

### 2. Variables privadas de Netlify

Verificar sin exponer sus valores:

- `AIRTABLE_API_TOKEN`
- `AIRTABLE_BASE_ID`
- `ADMIN_PASSWORD`
- `ADMIN_TOKEN_SECRET`
- `AUTOMATION_JOB_SECRET`
- `PAYMENT_PROOF_ENCRYPTION_KEY` — 32 bytes, preferiblemente base64
- `GEMINI_API_KEY`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_SECRET`, `MAIL_FROM`
- `ADMIN_NOTIFY_EMAIL`
- `MKJ_BASE_URL`, `MKJ_ORG_ID`, `MKJ_ADMIN_EMAIL`, `MKJ_ADMIN_PASSWORD`
- `URL`

No activar el piloto si Salud o el preflight señalan un faltante.

### 3. Extender Airtable antes del despliegue

La migración solo añade tablas/campos y nace con automatizaciones apagadas.

```bash
AIRTABLE_TARGET_ENVIRONMENT=production \
AIRTABLE_TARGET_BASE_ID=app4nE4ReGRi2SuP2 \
node scripts/smart-payment-airtable-migrate.js plan
```

Revisar el artefacto generado. Después:

```bash
AIRTABLE_TARGET_ENVIRONMENT=production \
AIRTABLE_TARGET_BASE_ID=app4nE4ReGRi2SuP2 \
SMART_PAYMENT_MIGRATION_CONFIRM=APPLY_SMART_PAYMENT_V2_TO_PRODUCTION \
node scripts/smart-payment-airtable-migrate.js apply
```

Y verificar:

```bash
AIRTABLE_TARGET_ENVIRONMENT=production \
AIRTABLE_TARGET_BASE_ID=app4nE4ReGRi2SuP2 \
node scripts/smart-payment-airtable-migrate.js verify
```

### 4. Etiquetar gastos existentes

Primero planificar y revisar que solo se añadirán metadatos:

```bash
AIRTABLE_TARGET_ENVIRONMENT=production \
AIRTABLE_TARGET_BASE_ID=app4nE4ReGRi2SuP2 \
node scripts/expense-lifecycle-backfill.js plan
```

Aplicar:

```bash
AIRTABLE_TARGET_ENVIRONMENT=production \
AIRTABLE_TARGET_BASE_ID=app4nE4ReGRi2SuP2 \
EXPENSE_LIFECYCLE_CONFIRM=APPLY_EXPENSE_LIFECYCLE_V1_TO_PRODUCTION \
node scripts/expense-lifecycle-backfill.js apply
```

Verificar:

```bash
AIRTABLE_TARGET_ENVIRONMENT=production \
AIRTABLE_TARGET_BASE_ID=app4nE4ReGRi2SuP2 \
node scripts/expense-lifecycle-backfill.js verify
```

## Único despliegue

1. Ejecutar `npm run verify`.
2. Integrar la rama preparada a `main`.
3. Hacer un solo push que produzca un solo despliegue de producción.
4. Esperar estado `ready` y revisar logs de build/functions.
5. No activar todavía el piloto.

## Pruebas posteriores al despliegue

- Portal público abre, contiene 15 casas y mantiene la deuda visible.
- Las sumas USD + Bs Ref. coinciden con el total de cada casa.
- Vencimiento, fecha de limitación y beneficio usan las reglas configuradas.
- Admin inicia sesión y abre Dashboard, Salud, Gastos, Pagos, Portón y Auditoría.
- La prueba visual automatizada de escritorio y móvil se ejecuta en un entorno con Chromium instalado.
- Se puede crear y anular un gasto de prueba controlado sin borrado físico.
- La precarga del mes siguiente aparece como `PRECARGADO` y no afecta el mes actual.
- Un reporte de prueba queda pendiente o es aprobado exactamente una vez.
- El comprobante queda cifrado; la clave no aparece en respuestas ni logs.
- Un reporte pendiente no cambia saldo ni portón.
- Un pago confirmado genera recibo, recalcula saldo e invalida la fotografía pública.
- El despachador del piloto responde que el trabajo fue encolado.
- Salud no muestra errores críticos.

## Activación sin nuevos despliegues

Desde `Piloto automático`:

1. Confirmar vencimiento, recargo y día de limitación.
2. Habilitar analizador de comprobantes y probar primero con aprobación automática apagada.
3. Revisar varios reportes reales y comparar la extracción.
4. Habilitar aprobación automática con confianza mínima de 97% o superior.
5. Habilitar avisos, precarga, cierre y portón.
6. Activar el interruptor maestro escribiendo `CONFIRMAR_AUTOMATIZACION`.

Todos estos pasos son configuración en Airtable: no requieren otro despliegue.

## Reversión

Ante cualquier comportamiento inesperado:

1. Apagar el interruptor maestro. Esto detiene aprobaciones, cierres, precarga, avisos y portón automáticos sin borrar datos.
2. Cambiar el portón a modo Manual si el incidente afecta MKJoules.
3. Revisar Salud, Auditoría, `ControlVersiones` y `Cierres de Auditoría`.
4. Restaurar el despliegue productivo anterior desde Netlify si el problema es de código.
5. No repetir manualmente una operación marcada parcial; usar el flujo protegido de reparación.

## Criterio de aceptación final

El sistema queda apto para activación cuando `npm run verify` pasa, la migración y el backfill verifican cero pendientes, Salud no presenta errores críticos, los saldos de las 15 casas cuadran, y una prueba completa de reporte → validación → pago → recibo → saldo → portón termina exactamente una vez.
