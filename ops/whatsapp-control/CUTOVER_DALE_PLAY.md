# CUTOVER DALE PLAY · VLA WhatsApp Admin

**NO ejecutar este procedimiento sin autorización expresa `DALE PLAY`.**

El objetivo es pasar del workflow programado actual al control único desde Admin sin alterar el agente de envío, credenciales financieras, saldos, pagos, cierre ni MKJ/portón.

## Principio de seguridad

Durante todo el proceso:

- el agente WhatsApp existente permanece intacto;
- el nuevo controlador nace y permanece `paused` mientras se prueba la ruta de control;
- el workflow programado actual sigue siendo el único planificador hasta el momento exacto del corte;
- nunca se dejan simultáneamente el planificador viejo y el nuevo modo Automático activos.

## Fase 0 · Baseline y respaldo

1. Confirmar producción estable.
2. Registrar SHA exacto de `main`.
3. Crear respaldo Git de `main`.
4. Ejecutar `INSTALAR_CONTROLADOR_PAUSADO.command`, que antes de instalar:
   - copia `.env` local sin imprimir secretos;
   - copia compose actual;
   - exporta todos los workflows n8n;
   - copia estado del agente;
   - conserva cualquier controlador previo.
5. Confirmar `whatsapp-agent` sigue `real`, saludable y con la sesión vinculada.
6. Confirmar el nuevo `whatsapp-controller` responde `mode=paused`.

**Abortar ante cualquier diferencia inesperada.**

## Fase 1 · Gateway n8n sin automatización

1. Crear una credencial Header Auth nueva exclusivamente para Netlify → n8n:
   - Header: `X-VLA-Control-Secret`
   - valor aleatorio de al menos 32 bytes;
   - no reutilizar `WA_AGENT_TOKEN`;
   - no imprimir ni guardar el valor en Git.
2. Mantener la credencial local del agente existente (`Header Auth account`) sin cambiar su valor.
3. Preparar el JSON `VLA_WhatsApp_Admin_Gateway_v1.template.json` reemplazando únicamente los **IDs** de las dos credenciales.
4. Importar el gateway.
5. Verificar que no contiene Schedule Trigger.
6. Publicar únicamente el gateway para habilitar su webhook.
7. Probar desde una petición autenticada de diagnóstico:
   - `status` debe responder;
   - `warmup` puede comprobar sesión;
   - el controlador debe continuar `paused`;
   - `run-now` debe quedar bloqueado mientras esté `paused`.

El workflow programado actual continúa funcionando durante esta fase.

## Fase 2 · Variables Netlify

Configurar como variables de entorno de runtime de Functions:

- `VLA_WHATSAPP_CONTROL_URL`: URL HTTPS del webhook de producción n8n, terminada en `/webhook/vla-whatsapp-control-v1`.
- `VLA_WHATSAPP_CONTROL_SECRET`: el mismo secreto creado para `X-VLA-Control-Secret`.

No introducir valores en `netlify.toml` ni en archivos del repositorio.

## Fase 3 · Validación previa al deploy

Antes de publicar VLA:

1. Ejecutar `npm test`.
2. Ejecutar `npm run verify`.
3. Ejecutar `npm run verify:portal`.
4. Ejecutar `ops/whatsapp-control/VALIDAR_100X.command`.
5. Comparar la rama contra el baseline.
6. El diff permitido debe limitarse a:
   - `netlify.toml` únicamente para registrar la edge de WhatsApp;
   - `netlify/edge-functions/admin-whatsapp-control.js`;
   - `netlify/functions/whatsapp-control.js`;
   - `ops/whatsapp-control/**`;
   - `tests/whatsapp-admin-control.test.js`;
   - `whatsapp.html`.
7. `admin-premium.js`, finanzas, cierres, pagos, MKJ, portón y credenciales no pueden aparecer modificados.
8. Confirmar que `netlify/functions/whatsapp-jobs.js` mantiene exactamente el mismo SHA que el baseline.

Si aparece cualquier archivo adicional, **abortar**.

## Fase 4 · Un único deploy VLA

Solo después de las fases anteriores:

1. Merge controlado de la rama aprobada.
2. Un solo deploy productivo de Netlify.
3. Sin cambiar todavía el planificador actual de n8n.

## Fase 5 · Smoke test del Admin

Entrar normalmente a `/admin.html` y verificar:

1. Existe una sola opción `WhatsApp` en el menú premium.
2. No existe una segunda pantalla operativa de Comunicaciones; `/whatsapp.html` redirige al mismo control.
3. Dashboard, Propietarios, Pagos, Gastos, Salud, Portón y Auditoría siguen abriendo normalmente.
4. Panel WhatsApp muestra estado del agente.
5. `Verificar WhatsApp` termina con sesión vinculada.
6. Guardar modo `manual` con un horario de prueba válido y refrescar: la configuración debe persistir.
7. Cambiar a `paused` y refrescar: debe persistir.
8. Fuera de 08:00–21:00, `Ejecutar recordatorios ahora` debe ser rechazado.
9. Dentro de la ventana, no hacer un envío manual real como simple smoke test salvo autorización específica; usar el ciclo real correspondiente y la idempotencia existente.

## Fase 6 · Corte del planificador

Solo cuando el Admin ya haya pasado el smoke test:

1. Poner el nuevo controlador `paused`.
2. Exportar nuevamente workflows n8n como respaldo inmediatamente anterior al corte.
3. Despublicar/desactivar **solo** el workflow programado actual `VLA WhatsApp Orchestrator v1.2.1 - SIMULACION - 2 REVISIONES + WARMUP`.
4. Confirmar que el gateway nuevo sigue publicado.
5. Desde Admin, configurar los horarios de revisión deseados.
6. Desde Admin, cambiar el nuevo controlador a `automatic`.
7. Confirmar que existe un solo planificador automático.

## Fase 7 · Observación del primer ciclo

En el primer ciclo automático:

- warmup debe ejecutarse antes de la revisión;
- `/tick` debe ir con `forcePlan:false`;
- el agente determina si existe ciclo vigente;
- se revalidan saldos;
- cada envío debe confirmarse por burbuja saliente;
- el historial Admin debe reflejar resultado;
- no debe haber duplicados.

No considerar el corte cerrado hasta observar al menos un ciclo automático correcto.

## Rollback

### Antes del corte del planificador

Ejecutar `ROLLBACK_CONTROLADOR.command`. El workflow actual nunca se tocó, por lo que el sistema anterior sigue operativo.

### Después del corte del planificador

1. Poner el nuevo controlador `paused`.
2. Despublicar/desactivar el gateway nuevo si es necesario.
3. Restaurar/publicar el workflow anterior desde el export realizado inmediatamente antes del corte.
4. Confirmar que el workflow anterior vuelve a ser el único planificador.
5. Ejecutar `ROLLBACK_CONTROLADOR.command`.
6. No tocar `whatsapp-agent`, su perfil ni su `WA_AGENT_TOKEN`.
7. Si el problema está únicamente en la UI de Netlify, revertir el commit/deploy VLA al baseline sin alterar Mac/n8n.

## Criterio de cierre

El sistema se declara operativo solo cuando:

- Admin controla modo/horarios/warmup/disparo/estado;
- WhatsApp sigue vinculado;
- primer ciclo automático fue observado;
- no hubo duplicados;
- el diff financiero/operativo no contiene cambios ajenos a WhatsApp;
- no se expuso ni cambió ninguna credencial existente;
- existe rollback probado/documentado.
