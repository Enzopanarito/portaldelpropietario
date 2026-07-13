# Airtable Staging — Villas Los Apamates

## Objetivo

Aislar los deploy previews y branch deploys de los datos reales de los 15 propietarios. Ningún preview debe leer ni escribir el Base de producción.

## Variables obligatorias

### Producción

- `CONTEXT=production` — suministrada por Netlify.
- `AIRTABLE_BASE_ID` — Base activo de producción.
- `AIRTABLE_PRODUCTION_BASE_ID` — debe coincidir exactamente con `AIRTABLE_BASE_ID`.
- `AIRTABLE_STAGING_BASE_ID` — Base de pruebas; debe ser distinto.

### Deploy Preview / Branch Deploy

- `AIRTABLE_BASE_ID` — debe apuntar al Base de staging.
- `AIRTABLE_STAGING_BASE_ID` — debe coincidir exactamente con `AIRTABLE_BASE_ID`.
- `AIRTABLE_PRODUCTION_BASE_ID` — se usa para bloquear cualquier cruce accidental.

La función `_environment_guard.js` falla de forma segura si falta el Base de staging, si un preview apunta a producción o si producción apunta a staging.

## Preparación del Base de staging

1. Duplicar manualmente la estructura del Base productivo desde Airtable.
2. No copiar automatizaciones externas activas, correos reales ni credenciales MKJoules.
3. Mantener las mismas tablas, nombres de campos, tipos, opciones y relaciones requeridas por el motor.
4. Sembrar exactamente 15 propietarios de prueba, casas 1 a 15.
5. Sustituir nombres, teléfonos, correos, referencias y adjuntos por datos ficticios.
6. Conservar casos financieros representativos:
   - solvente;
   - deuda solo USD;
   - deuda solo Bs BCV;
   - ambas monedas;
   - saldo a favor;
   - pago parcial;
   - cuota especial;
   - pago histórico `LEGACY`;
   - reporte pendiente;
   - cierre mensual simulado.
7. Desactivar cualquier acción que pueda enviar mensajes, correos o modificar accesos reales.

## Activación segura

1. Configurar las variables por contexto en Netlify.
2. Abrir un deploy preview.
3. Confirmar que `admin-data`, `public-data` y `monthly-close` responden desde staging.
4. Ejecutar CI completo.
5. Probar pagos y cierres únicamente con registros ficticios.
6. Verificar que no apareció ningún registro nuevo en producción.

## Bloqueos esperados

El sistema debe responder con `safeBlock: true` y código `AIRTABLE_*` cuando detecta una combinación peligrosa. No debe intentar hacer fallback a producción.

## Rollback

1. Desactivar el deploy preview o restaurar sus variables de staging.
2. No cambiar `AIRTABLE_BASE_ID` de producción durante el rollback.
3. La protección es puramente preventiva y no migra ni modifica datos por sí sola.
4. Si una prueba de staging falla, eliminar únicamente los datos ficticios del Base de staging.

## Regla operativa

Nunca se sincronizan datos personales reales hacia staging de forma automática. Cualquier snapshot usado para reproducir un incidente debe ser sanitizado y revisado antes de cargarse.
