# Fotografía pública persistente con Netlify Blobs

## Objetivo

Reducir las lecturas pasivas de Airtable sin cambiar la fuente financiera oficial. La fotografía contiene únicamente datos ya calculados por el motor v5 y `ControlVersiones`.

## Garantías

Antes de guardar una fotografía, el servidor exige:

- `balanceEngineVersion = 5`;
- `officialBalanceSource = ControlVersiones`;
- exactamente 15 propietarios;
- casas únicas y ordenadas del 1 al 15;
- saldos USD, Bs. Ref. y total numéricos;
- total de cada casa igual a USD + Bs. Ref. dentro de la tolerancia financiera.

Una fotografía inválida nunca se publica.

## Comportamiento de la bandera

### `PUBLIC_BLOB_CACHE_ENABLED` ausente o `false`

`public-data-v3` delega exactamente en `public-data-v2`. El parámetro histórico `?force=1` continúa funcionando y no cambia el comportamiento actual de producción.

### `PUBLIC_BLOB_CACHE_ENABLED=true`

1. Una fotografía vigente se devuelve sin consultar Airtable.
2. Una fotografía vencida puede servirse temporalmente mientras un único proceso la reconstruye.
3. El proceso que obtiene el lease consulta Airtable con reconstrucción forzada y escribe una fotografía validada.
4. Si Airtable falla y existe una fotografía válida anterior, se sirve marcada como antigua mediante cabeceras de advertencia.
5. Si Blobs falla, se utiliza la ruta directa actual de Airtable; el caché nunca es una dependencia obligatoria para mostrar datos frescos.
6. Si no existe fotografía y otro proceso ya está reconstruyendo, se devuelve HTTP 503 con `Retry-After: 3`; nunca se lanzan reconstrucciones paralelas sin lease.

## Invalidación

La fotografía se invalida únicamente después de una mutación exitosa que puede cambiar los datos públicos:

- pago manual;
- aprobación o rechazo de reporte de pago;
- creación de gasto;
- eliminación de gastos;
- cierre mensual real.

No se invalida por:

- lecturas;
- simulaciones del cierre;
- telemetría;
- salud del sistema;
- contador de API;
- actividad de WhatsApp.

La invalidación es `fail-soft`: una falla de Blobs no revierte una escritura financiera ya completada. La respuesta administrativa incluye una cabecera de advertencia y la fotografía vencerá por TTL.

## Variables

- `PUBLIC_BLOB_CACHE_ENABLED=false` inicialmente.
- `PUBLIC_BLOB_CACHE_MAX_AGE_MS=120000` recomendado para la primera activación.
- `VLA_DATA_ENVIRONMENT=production` en producción.

## Activación segura

1. Fusionar únicamente con todas las matrices verdes sobre el mismo SHA.
2. Confirmar los 15 saldos contra la fotografía previa.
3. Desplegar con `PUBLIC_BLOB_CACHE_ENABLED=false`.
4. Verificar portal público, administrador y funciones financieras.
5. Cambiar solamente `PUBLIC_BLOB_CACHE_ENABLED=true`.
6. Abrir el portal y comprobar `X-Public-Snapshot: REFRESH` en la primera carga.
7. Recargar y comprobar `X-Public-Snapshot: HIT` y `X-Airtable-Calls: 0`.
8. Realizar una mutación controlada en staging y verificar invalidación.
9. Repetir en producción únicamente después de revisar la comparación financiera.

## Rollback

Cambiar `PUBLIC_BLOB_CACHE_ENABLED=false`. No requiere borrar Blobs y restaura inmediatamente la ruta anterior. Con la bandera apagada, los Blobs existentes no se leen ni se escriben.

## Observabilidad

Cabeceras principales:

- `X-Public-Snapshot: HIT`
- `X-Public-Snapshot: REFRESH`
- `X-Public-Snapshot: STALE`
- `X-Public-Snapshot: STALE_FALLBACK`
- `X-Public-Snapshot: BLOB_UNAVAILABLE`
- `X-Public-Snapshot-Invalidation: invalidated|disabled|failed`
