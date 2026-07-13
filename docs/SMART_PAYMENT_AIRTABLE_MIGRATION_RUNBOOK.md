# Runbook — Migración Airtable Reportes Inteligentes V2

## Principio

La migración crea estructura y configuración fail-closed. No procesa comprobantes, no modifica saldos, no crea pagos y no llama MKJoules.

## Entornos permitidos

- Producción: `app4nE4ReGRi2SuP2`
- Staging: `appZhq8nVZ7lZ2k6K`

Cualquier otro Base ID es rechazado.

## Modos

### Plan

```bash
SMART_PAYMENT_MIGRATION_MODE=plan \
AIRTABLE_TARGET_ENVIRONMENT=staging \
AIRTABLE_TARGET_BASE_ID=appZhq8nVZ7lZ2k6K \
AIRTABLE_API_TOKEN='***' \
node scripts/smart-payment-airtable-migrate.js plan
```

Solo lee metadatos y escribe un artefacto local del plan.

### Verify

Falla si queda una tabla, campo o inicialización pendiente.

### Apply staging

Requiere exactamente:

```text
APPLY_SMART_PAYMENT_V2_TO_STAGING
```

### Apply production

Requiere exactamente:

```text
APPLY_SMART_PAYMENT_V2_TO_PRODUCTION
```

## Orden interno

1. Validar opciones históricas protegidas.
2. Crear `Cuentas de Cobro Autorizadas`, si falta.
3. Volver a leer metadatos.
4. Crear campos faltantes en tablas existentes.
5. Volver a leer metadatos.
6. Inicializar únicamente campos de Configuración recién creados.
7. Sembrar receptores ausentes por `Identificador`.
8. Emitir ledger.
9. Replanificar; el resultado debe ser vacío.

## Banderas posteriores a migración

Deben quedar en `false`:

- AI Enabled
- AI Secondary Enabled
- External AI Fallback Enabled
- Automatic Provisional Access Enabled

`Manual Review Urgent Enabled` puede quedar en `true` porque no habilita acceso ni aprueba pagos.

## Tablas que la migración no puede modificar

- Pagos
- Recibos de Pago
- ControlVersiones
- Historial de Cargos
- Cierres de Auditoría
- WhatsApp Jobs
- WhatsApp Programaciones

Tampoco actualiza registros existentes de Propietarios o Reportes de Pago.

## Ledger y rollback

El ledger conserva IDs de:

- tabla creada;
- campos creados;
- receptores sembrados;
- registro de configuración inicializado.

El rollback estructural solo debe ejecutarse antes de que existan datos V2. Una vez que haya reportes V2, los campos no se eliminan: se apagan las banderas y se conserva la trazabilidad.

## Compuertas previas a producción

- respaldo Git vigente;
- respaldo Airtable completo verificado;
- 15 CURRENT_BALANCE idénticos;
- CI de migración verde;
- plan productivo revisado;
- staging verificado;
- ninguna función AI o acceso automático activa.

## Compuertas posteriores

- replanificación vacía;
- tres receptores presentes una sola vez;
- opciones históricas intactas;
- 15 CURRENT_BALANCE idénticos;
- cero cambios en Pagos, Recibos y MKJ;
- ledger archivado.
