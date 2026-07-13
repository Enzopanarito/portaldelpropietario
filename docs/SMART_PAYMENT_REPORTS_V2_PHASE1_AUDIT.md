# Reportes de Pago Inteligentes V2 — Auditoría real y diseño de Fase 1

Fecha de auditoría: 2026-07-13  
Base Airtable: `app4nE4ReGRi2SuP2`  
Repositorio: `Enzopanarito/portaldelpropietario`  
Base Git protegida: `3636b709edde07437406d7d3eb9c54ac5bcf5574`

## 1. Estado verificado antes de cambiar

- Se creó la rama de respaldo `backup-2026-07-13-before-smart-payment-reports-v2` en el SHA exacto de `main`.
- Airtable conserva un respaldo completo previo: `FULL_BACKUP|CONTROLVERSIONES_TELEMETRY_V1|DONE`, 2.974 registros, SHA-256 `0ee0671718c6a88d5c1037d3c1e9acadd77d68f1208f3ae92342beaa304d558f`.
- Los 15 registros `CURRENT_BALANCE` coinciden, centavo por centavo, con la línea base protegida de julio 2026.
- No se modificó ningún saldo, pago, reporte, propietario ni usuario MKJ durante esta auditoría.

## 2. Arquitectura vigente confirmada

### Reporte público

`netlify/functions/public-report-payment.js`:

1. valida propietario, cuenta, monto, moneda escrita y referencia;
2. aplica límites por IP y propietario;
3. obtiene la tasa BCV persistida;
4. acepta comprobante opcional de hasta 3 MB;
5. evita únicamente duplicados recientes de cinco minutos;
6. crea el registro en `Reportes de Pago`;
7. llama inmediatamente a `syncOwnerAccess()`;
8. envía correo al administrador.

### Riesgo actual que debe eliminar V2

El acceso puede habilitarse actualmente porque un reporte `Pendiente` cubre la deuda vencida, sin que exista análisis del comprobante. La función `_access_control.js` suma los reportes pendientes y los considera cobertura provisional. Este comportamiento no satisface la política V2.

V2 reemplazará esa regla por una habilitación ligada a un reporte específico que cumpla simultáneamente:

- archivo requerido cuando el propietario estaba `Limitado`;
- hash no duplicado;
- extracción estructurada disponible o validación humana;
- receptor autorizado;
- operación completada/enviada/procesada;
- monto suficiente contra un snapshot vigente;
- idempotencia adquirida;
- confirmación positiva de MKJoules.

### MKJoules

La integración vigente:

- inicia sesión en `/api/auth/login`;
- usa la organización configurada por `MKJ_ORG_ID` (fallback histórico `1053`);
- habilita o limita mediante `PUT /api/organizations/{org}/members/{id}/{enable|disable}`;
- actualiza `Estado Acceso Portón`, `Última Sync MKJ` y `Motivo Limitación Acceso` en Airtable;
- respeta `Modo Control Portón = Manual` y `Excepción Acceso`.

V2 conservará esos contratos, pero añadirá una operación idempotente con ID propio y comprobación del reporte habilitante vigente.

### Aprobación administrativa

`process-payment-report.js` ya posee un guard persistente e idempotencia para evitar pagos duplicados. Sin embargo:

- el rechazo no exige todavía motivo;
- no verifica si el reporte rechazado sigue siendo el habilitante actual;
- no verifica pagos o reportes válidos posteriores antes de limitar;
- no conserva decisión, revisor, fecha ni relación explícita con el pago definitivo;
- no distingue validación automática, secundaria o manual.

## 3. Esquema Airtable realmente existente

### `Reportes de Pago` (`tbliXVkmakLljmhM1`)

Existen únicamente diez campos:

- Reporte
- Propietario que Reporta
- Monto Reportado
- Referencia
- Fecha del Reporte
- Estado
- Forma de Pago Reportada
- Monto Reportado Bs
- Tasa BCV Reporte
- Equivalente USD Reportado

`Estado` conserva exactamente: `Pendiente`, `Confirmado`, `Rechazado`.

### `Propietarios` (`tbl1CmkjMJEW0C6vG`)

Los campos de portón confirmados son:

- Estado Acceso Portón
- Excepción Acceso
- Motivo Limitación Acceso
- MKJ User ID
- MKJ Email
- Última Sync MKJ

`Estado Acceso Portón` conserva exactamente:

- Sin configurar
- Habilitado
- Limitado
- Error Sync
- Excepción Manual

No existen todavía campos de habilitación provisional.

### `Configuración` (`tblvNGv2Ege0BEHr6`)

Existe un solo registro, `Configuración General`, con `Modo Control Portón = Automático`.

## 4. Decisiones de diseño definitivas

1. **No se modifica el campo histórico `Estado`.** El flujo detallado vive en `Estado de Procesamiento` y `Decisión Administrativa`.
2. **Airtable no será el candado concurrente.** Netlify Blobs con consistencia fuerte y CAS seguirá siendo la fuente de idempotencia y leases.
3. **Los archivos no viajarán indefinidamente en JSON/base64.** Se almacenarán cifrados o privados en Netlify Blobs; Airtable conservará hashes, metadatos y, cuando sea seguro, el attachment administrable.
4. **El frontend no decide si el propietario está limitado.** El servidor relee al propietario y construye el snapshot oficial.
5. **Los reportes pendientes comunes dejan de cubrir deuda para MKJ.** Solo un reporte con `Habilitación Provisional Aplicada = true`, vigente y vinculado como `Reporte Habilitante Actual` puede justificar la habilitación provisional.
6. **El rechazo es conservador.** Solo limita si el reporte rechazado continúa siendo el habilitante, persiste deuda, no existe pago/reporte posterior válido, no hay excepción y no existe habilitación manual vigente.
7. **Airtable AI queda desacoplado.** El backend consume una salida estructurada con contrato versionado. El nombre del modelo no se hardcodea.
8. **No se activa proveedor externo.** `External AI Fallback Enabled` inicia en falso.
9. **La falla de ambos análisis termina en revisión manual urgente, nunca en habilitación automática.**
10. **La huella global consulta todas las casas y todos los estados.** Una referencia aislada solo genera sospecha, no rechazo automático.

## 5. Restricción externa confirmada

La API conectada permite leer y modificar bases, tablas, campos y registros, pero no expone la lista de modelos disponibles ni permite configurar agentes de Airtable AI. Por tanto:

- el código y el esquema pueden quedar completamente preparados y probados;
- los campos de entrada/salida para agente principal y secundario serán creados;
- la selección real de modelos y la automatización Airtable AI debe validarse en la interfaz de la cuenta antes de habilitar `AI Enabled`;
- hasta esa validación, el sistema permanece en revisión manual y no consume créditos.

## 6. Fases y compuertas

### Fase 1 — auditoría y esquema

- respaldo Git y respaldo Airtable verificados;
- manifiesto de esquema versionado;
- migración idempotente y reversible;
- tabla de cuentas autorizadas;
- campos faltantes sin duplicados;
- valores iniciales desactivados;
- cero cambios en saldos y MKJ.

### Fase 2 — archivo, hash y snapshot

- carga por streaming/control de tamaño;
- firma MIME y calidad básica;
- HEIC/WebP/PDF;
- SHA-256 y hash perceptual;
- snapshot financiero v5;
- búsqueda global previa a IA.

### Fase 3 — adaptadores IA

- contrato principal/secundario;
- JSON crudo inmutable;
- normalización estricta;
- límites de intentos;
- fallback externo apagado.

### Fase 4 — árbitro determinístico

- normalización de receptor;
- moneda, monto, fecha, estado y referencia;
- huella financiera;
- evaluación explicable por regla.

### Fase 5 — MKJ

- habilitación idempotente;
- confirmación y operation ID;
- vencimiento;
- reversión protegida.

### Fase 6 — contingencia humana

- revisión urgente con cooldown;
- validación manual completa;
- habilitación temporal justificada y auditada.

### Fases 7–9

- frontend condicional y polling;
- panel administrativo comparativo;
- 37 escenarios, deploy gradual y rollback.

## 7. Condición de seguridad para activar

Ninguna habilitación automática V2 podrá ejecutarse mientras cualquiera de estas condiciones sea falsa:

- esquema versión esperada;
- fuente financiera v5 vigente;
- AI configurada o revisión manual completa;
- cuenta autorizada vigente;
- idempotencia adquirida;
- snapshot no vencido;
- MKJ en modo Automático;
- reporte aún Pendiente;
- propietario aún vinculado a la misma casa;
- ausencia de duplicado global.
