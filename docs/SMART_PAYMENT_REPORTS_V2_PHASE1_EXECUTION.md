# Reportes de Pago Inteligentes V2 — Ejecución de Fase 1

Fecha: 2026-07-13

## Respaldos

- Git: `backup-2026-07-13-before-smart-payment-reports-v2`.
- Airtable: respaldo completo verificado de 2.974 registros, SHA-256 `0ee0671718c6a88d5c1037d3c1e9acadd77d68f1208f3ae92342beaa304d558f`.
- Los 15 `CURRENT_BALANCE` de producción se verificaron antes de la Fase 1 y no fueron modificados.

## Staging creado

- Base: `appZhq8nVZ7lZ2k6K`.
- Nombre: `Villas Los Apamates — STAGING (DATOS FICTICIOS)`.
- Workspace: `wspaZ8Xq2tNm4Ce0O`.
- Datos personales reales: no.
- MKJ User IDs reales: no; permanecen vacíos.
- Acciones automáticas: apagadas.

## Datos de prueba

- 15 propietarios ficticios, uno por casa.
- Correos `@staging.invalid` y teléfonos ficticios.
- 15 fotografías `CURRENT_BALANCE` con las combinaciones financieras protegidas de julio.
- Tabla legacy preservada para probar una migración realista.

## Esquema V2 aplicado en staging

- `Cuentas de Cobro Autorizadas`: 18 campos, 3 receptores versionados.
- `Reportes de Pago`: esquema V2 completo con archivo, snapshot, procesamiento, IA, datos normalizados, duplicados, evaluación, acceso, administración y contingencia.
- `Propietarios`: 8 controles provisionales añadidos sin cambiar `Estado Acceso Portón` ni `Excepción Acceso`.
- `Configuración`: flags, límites, versiones, tiempos y controles de contingencia.

## Receptores iniciales

1. `VE_TRANSFER_ENZO`: titulares ENZO PANARITO y ENZO JOSE PANARITO, con variantes normalizadas. Banco/cuenta pendiente de completar antes de activar automatización.
2. `VE_MOBILE_04140554700`: teléfono normalizado `04140554700`.
3. `US_ZELLE_ENZO`: correo normalizado `enzopanarito@gmail.com`.

## Estado seguro inicial

Los siguientes controles están apagados:

- `AI Enabled`.
- `AI Secondary Enabled`.
- `External AI Fallback Enabled`.
- `Automatic Provisional Access Enabled`.

Permanece encendido únicamente `Manual Review Urgent Enabled`, que no habilita el portón ni crea pagos.

## Limitación de Airtable AI

La API conectada no expone los modelos disponibles ni permite crear/configurar agentes de Airtable AI. Ningún modelo se inventó ni se hardcodeó. La selección principal/secundaria deberá verificarse en la interfaz de la cuenta antes de activar IA. Hasta entonces, el sistema V2 debe operar en modo manual seguro.

## Rollback de staging

Staging es una base separada. Su eliminación o desuso no afecta producción. Las acciones de Airtable generadas durante la construcción conservan sus identificadores de rollback en el registro de herramientas de esta sesión.

## Criterios para producción

No se aplicará el esquema a producción hasta que:

- los manifiestos y el contrato JSON estén verdes en CI;
- el inventario real no encuentre campos equivalentes;
- exista una migración idempotente con plan, apply y ledger;
- IA y habilitación automática permanezcan apagadas tras migrar;
- se comparen otra vez las 15 casas antes y después;
- no exista ninguna escritura sobre MKJ.
