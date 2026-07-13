# Idempotencia atómica con Netlify Blobs

## Propósito

Evitar dobles pagos, decisiones concurrentes y cierres mensuales duplicados cuando existen dobles clics, reintentos de red o funciones ejecutándose al mismo tiempo.

## Arquitectura

1. Netlify Blobs, con consistencia fuerte, adquiere la clave lógica mediante escritura condicional `onlyIfNew`.
2. Airtable conserva la bitácora existente como segunda barrera y registro de auditoría.
3. Las transiciones usan ETag y `onlyIfMatch`.
4. Una operación completada devuelve el mismo resultado sin repetir la escritura financiera.
5. Una operación parcial permanece bloqueada hasta revisión.
6. Un error demostrado antes de escribir expira el candado y permite un nuevo intento.
7. Producción y staging usan namespaces distintos derivados del entorno y del Base ID.

## Operaciones cubiertas

- pago manual;
- aprobación o rechazo de reporte de pago;
- cierre mensual.

## Estados

- `RUNNING`: existe un ejecutor propietario;
- `DONE`: operación completada, no se repite;
- `PARTIAL`: hubo o pudo haber una escritura, revisión obligatoria;
- `ERROR_SAFE`: no se demostró escritura financiera y el candado puede reclamarse.

## Activación

No requiere una tabla Airtable nueva. Requiere que el despliegue tenga acceso normal a Netlify Blobs.

Antes de fusionar:

- todas las pruebas del PR deben corresponder al mismo SHA;
- debe pasar la matriz completa existente;
- debe comprobarse que `main` no se movió o actualizar la rama;
- deben compararse los 15 saldos contra la fotografía previa.

## Rollback

La reversión consiste en restaurar:

- `_operation_guard.js` para que apunte a `_operation_guard_v2`;
- las versiones anteriores de `admin-manual-payment.js`, `process-payment-report.js` y `monthly-close-v2.js`.

No se eliminan inmediatamente los Blobs ya creados. Mantenerlos durante la ventana de observación evita que una reversión seguida de una reactivación pierda el historial de idempotencia.

## Regla de seguridad

Si el cierre mensual ya fue entregado al ejecutor y después ocurre una excepción incierta, se marca `PARTIAL`; nunca se libera automáticamente para repetirlo.
