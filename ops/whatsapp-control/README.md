# VLA · Control WhatsApp desde Admin

## Estado de este paquete

Este directorio prepara una capa de control para el sistema WhatsApp VLA ya existente.

**No reemplaza el agente de envío.** El agente VLA/Playwright/WhatsApp Web sigue siendo responsable de:

- determinar el ciclo mensual vigente;
- leer la fuente financiera canónica;
- revalidar saldos;
- construir el mensaje;
- evitar duplicados;
- abrir el chat correcto;
- enviar;
- confirmar la burbuja saliente antes de marcar como enviado;
- recuperar únicamente el ciclo vigente después de una interrupción.

El controlador nuevo solo administra desde `admin.html`:

- Automático / Manual / Pausado;
- horarios de **revisión automática**;
- minutos de precalentamiento;
- disparo manual;
- verificación de sesión WhatsApp;
- estado y auditoría local.

## Regla A de ejecución manual

El botón manual puede utilizarse fuera de los horarios automáticos, pero **nunca** fuera de la ventana 08:00–21:00, hora `America/Caracas`.

No existe bypass nocturno en el Admin.

## Horarios configurables

Los horarios configurables son horarios de revisión del agente existente. El controlador llama `/tick` exclusivamente con:

```json
{"forcePlan":false}
```

Por diseño, esta capa **no reescribe** las reglas mensuales internas del agente ni adelanta artificialmente un ciclo que el agente todavía considere futuro.

Esto mantiene intacta la lógica que ya fue probada y evita que una modificación de UI cambie silenciosamente la semántica financiera o de cobranza.

## Arquitectura

```text
Admin VLA
  ↓ sesión Admin existente
Netlify Function whatsapp-control
  ↓ X-VLA-Control-Secret
Webhook n8n dedicado
  ↓ x-agent-token dentro de la red local
WhatsApp Controller :8788
  ↓ x-agent-token
Agente WhatsApp existente :8787
  ↓
Playwright + WhatsApp Web
```

## Un solo módulo visible

La interfaz histórica `whatsapp.html` deja de ser un segundo panel. Se conserva como redirección a:

```text
/admin.html#whatsapp-control
```

El backend histórico `netlify/functions/whatsapp-jobs.js` y sus tablas de Airtable se conservan sin modificación para histórico/rollback. No forman parte del nuevo flujo de control.

## Seguridad

- `WA_AGENT_TOKEN` permanece en la Mac/n8n y nunca se entrega al navegador.
- `VLA_WHATSAPP_CONTROL_SECRET` es un secreto independiente para Netlify → n8n.
- Ningún secreto real se guarda en los JSON de workflow ni en este repositorio.
- El controlador escucha externamente solo en `127.0.0.1:8788` para diagnóstico local.
- El webhook n8n requiere Header Auth.
- La Function Netlify exige la sesión Admin existente mediante `requireAdmin`.
- El modo inicial del controlador es `paused`.

## Fuera de alcance

Este paquete no debe:

- crear o aprobar pagos;
- modificar saldos;
- modificar gastos;
- ejecutar cierre mensual;
- cambiar BCV;
- habilitar o limitar MKJ/portón;
- modificar credenciales financieras;
- modificar el perfil persistente de WhatsApp.

## Convivencia con el workflow actual

Mientras se instala/prueba el nuevo controlador, el workflow actual puede seguir operando.

El nuevo controlador debe permanecer **PAUSADO** hasta el corte final.

En el corte final solo puede existir un planificador automático:

1. comprobar nuevo Admin/controlador;
2. mantener nuevo controlador pausado;
3. publicar y probar el gateway n8n;
4. comprobar conexión Admin → n8n → controlador → agente;
5. desactivar el schedule del workflow anterior;
6. activar modo Automático en el controlador.

Nunca se deben dejar ambos planificadores automáticos activos a la vez.

## Variables nuevas de Netlify

Estas variables se crean únicamente durante el corte autorizado:

- `VLA_WHATSAPP_CONTROL_URL`
- `VLA_WHATSAPP_CONTROL_SECRET`

No reutilizar una credencial de Airtable, Admin, MKJ ni pagos.

## Pruebas

El archivo `tests/whatsapp-admin-control.test.js` cubre, entre otros:

- 1.440 minutos del día contra la barrera 08:00–21:00;
- horarios válidos e inválidos;
- 100 configuraciones consecutivas;
- 100 configuraciones fuera de ventana;
- 100 cálculos de warmup;
- 100 comparaciones relay/controlador;
- 100 inspecciones de secretos/`forcePlan`;
- modo inicial PAUSADO;
- gateway n8n inactivo y protegido;
- ausencia de mutaciones financieras en la nueva UI;
- reemplazo visual del panel viejo;
- conservación del backend histórico;
- exposición local del puerto 8788.

`VALIDAR_100X.command` repite toda la batería cien veces.

## Regla de publicación

Preparar una rama, ejecutar pruebas o crear estos archivos **no autoriza** merge ni despliegue de producción.

Producción se modifica únicamente después de autorización expresa `DALE PLAY` y después de ejecutar el checklist de `CUTOVER_DALE_PLAY.md`.