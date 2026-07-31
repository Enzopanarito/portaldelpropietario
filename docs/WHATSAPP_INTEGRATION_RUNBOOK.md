# Integración WhatsApp profesional — Runbook de activación segura

## Estado de diseño

La mensajería está integrada al portal administrativo, pero el envío real usa tres compuertas independientes y debe permanecer bloqueado hasta completar una prueba controlada en la Mac autorizada.

- `WHATSAPP_QUEUE_ENABLED`: permite crear y administrar lotes.
- `WHATSAPP_CONNECTOR_ENABLED`: permite que el host nativo local reclame y ejecute lotes.
- `WHATSAPP_REAL_SEND_ENABLED`: permite activar el clic real en WhatsApp Web.

Ninguna variable se interpreta como verdadera salvo que su valor sea exactamente `true`.

## Variables obligatorias

| Variable | Tipo | Regla |
|---|---|---|
| `MESSAGING_DISPATCH_SECRET` | secreto | Mínimo 32 caracteres. Debe ser exclusivo de mensajería y distinto de la contraseña o secreto administrativo. |
| `WHATSAPP_QUEUE_ENABLED` | bandera | `false` durante el primer despliegue. |
| `WHATSAPP_CONNECTOR_ENABLED` | bandera | `false` hasta instalar y comprobar la Mac. |
| `WHATSAPP_REAL_SEND_ENABLED` | bandera | `false` hasta aprobar una prueba real individual. |
| `AIRTABLE_API_TOKEN` | secreto existente | No cambiar como parte de esta integración. |
| `AIRTABLE_BASE_ID` | configuración existente | Debe seguir apuntando a la base oficial. |

Generación recomendada del secreto dedicado:

```bash
openssl rand -hex 32
```

No se debe escribir el valor en GitHub, Airtable, archivos del portal, capturas ni documentación.

## Secuencia de activación

### Fase 0 — Despliegue inerte

1. Crear respaldo de la rama `main` y confirmar el SHA de producción.
2. Confirmar la fotografía oficial de las 15 casas en `ControlVersiones`.
3. Configurar `MESSAGING_DISPATCH_SECRET`.
4. Mantener las tres banderas en `false`.
5. Desplegar el código y verificar que el portal existente, propietario, pagos, cierres y acceso continúan funcionando.

Resultado esperado: la pantalla de mensajería permite revisar y exportar, pero no crear ni ejecutar lotes.

### Fase 1 — Cola de simulación

1. Cambiar solamente `WHATSAPP_QUEUE_ENABLED=true`.
2. Mantener `WHATSAPP_CONNECTOR_ENABLED=false` y `WHATSAPP_REAL_SEND_ENABLED=false`.
3. Crear un lote de simulación desde el portal.
4. Verificar que se guarda en Netlify Blobs y que Airtable recibe únicamente el espejo redactado.
5. Confirmar que no se abre WhatsApp y no existe ningún envío.

### Fase 2 — Conector Mac en simulación

1. Ejecutar `mac-connector/scripts/install.sh` en la Mac autorizada.
2. Cargar la extensión sin empaquetar desde la carpeta indicada por el instalador.
3. Confirmar el ID fijo: `oopmhhmkihemkkjghmpepgfcmcomplph`.
4. Cambiar `WHATSAPP_CONNECTOR_ENABLED=true`.
5. Mantener `WHATSAPP_REAL_SEND_ENABLED=false`.
6. Comprobar el conector desde el portal y ejecutar el lote de simulación.
7. Verificar estados, heartbeat, pausa, continuación, cancelación y bitácora.

Resultado esperado: la Mac procesa la cola, pero no navega a chats ni activa Enviar.

### Fase 3 — Prueba real individual

1. Confirmar visualmente que Chrome usa la cuenta correcta de WhatsApp.
2. Seleccionar exactamente una casa autorizada para la prueba.
3. Guardar una nueva fotografía de los 15 saldos inmediatamente antes de habilitar la prueba.
4. Cambiar `WHATSAPP_REAL_SEND_ENABLED=true`.
5. Crear y ejecutar el lote real de una sola casa.
6. Confirmar en WhatsApp la burbuja saliente, el destinatario y el texto.
7. Confirmar en el portal que el estado sea `Enviado`, no `Verificar`.
8. Volver a comparar los 15 saldos. La mensajería no debe modificar ninguno.

Si el resultado queda en `Verificar`, resolverlo manualmente antes de cualquier otro envío. Nunca se debe reintentar automáticamente un intento incierto.

### Fase 4 — Lote real

El portal solo habilita el lote múltiple después de una prueba real individual completada para el mismo corte durante la sesión administrativa actual. Antes de ejecutar:

1. Revisar todos los textos.
2. Confirmar teléfonos y casas.
3. Confirmar que el corte oficial no cambió.
4. Confirmar que no existen mensajes `Verificar` pendientes.
5. Mantener una sola pestaña de WhatsApp Web.

## Modelo financiero de los mensajes

- Fuente obligatoria: motor financiero versión 5 y `ControlVersiones`.
- Las cuentas USD y Bs. BCV permanecen separadas.
- Los créditos no compensan automáticamente otra moneda.
- El ajuste interno nunca se menciona públicamente.
- El desglose por concepto proviene de `Gastos del Mes` y se identifica como **cargos informativos antes de pagos y créditos**.
- El saldo pendiente se comunica por cuenta oficial.
- El sistema no distribuye el saldo pendiente entre conceptos de Bs. porque no existe una regla oficial de asignación de pagos por concepto. Inventar esa distribución está prohibido.

## Respuesta ante incidentes

### Detención inmediata sin rollback de código

Configurar, en este orden:

```text
WHATSAPP_REAL_SEND_ENABLED=false
WHATSAPP_CONNECTOR_ENABLED=false
WHATSAPP_QUEUE_ENABLED=false
```

Esto bloquea nuevos lotes y ejecuciones sin afectar el resto del portal.

### Rollback de la Mac

```bash
bash mac-connector/scripts/rollback-latest.sh
```

El rollback restaura exactamente los componentes que existían y elimina los que estaban ausentes antes de la instalación.

### Rollback del portal

1. No borrar los trabajos ni la bitácora.
2. Revertir al SHA protegido de `main` o a la rama de respaldo aprobada.
3. Mantener las tres banderas en `false`.
4. Ejecutar nuevamente todas las matrices de CI.
5. Comparar las 15 casas contra la fotografía previa.

## Criterios para declarar “listo”

No se debe usar la palabra “listo” hasta que todos los puntos sean verdaderos:

- Todas las matrices de CI pertenecen al mismo SHA final y están verdes.
- Swift compila y sus pruebas pasan en macOS.
- El rollback funcional pasa en macOS.
- El portal de propietarios, administrador, móvil, pagos, cierres y acceso no presentan regresiones.
- La Mac real instala, comprueba y ejecuta una simulación.
- Una prueba real individual autorizada termina como `Enviado`.
- No hay estados `Verificar` sin resolver.
- Los 15 saldos finales coinciden con la fotografía previa.
- `main` solo se modifica mediante el PR revisado y aprobado.
