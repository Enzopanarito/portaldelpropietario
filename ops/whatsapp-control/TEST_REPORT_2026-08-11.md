# Informe de pruebas · WhatsApp Admin VLA

Fecha: 2026-08-11

Rama probada: `feature/whatsapp-admin-control-v1`

Baseline protegido: `backup/whatsapp-admin-prep-20260810-2252` → `ee7baa4d7eeefaf4d6c7c66835fd7d1c58695ff6`

## Alcance

Estas pruebas certifican la preparación **offline / simulada** de la nueva capa de control WhatsApp.

No se realizó deploy de Netlify, no se hizo merge a `main`, no se modificó la Mac mini productiva y no se enviaron WhatsApp reales durante estas pruebas.

La certificación integral Admin productivo → Netlify → n8n → controlador → agente real queda deliberadamente bloqueada hasta autorización `DALE PLAY`.

## Integridad del código probado

Se materializaron copias locales del código preparado y se verificó su Git blob SHA contra GitHub antes de ejecutar las pruebas principales.

SHA verificados:

- `controller.js`: `55c6796121b340294e800ae41b7a197874cb6922`
- `whatsapp-control.js`: `e4dd733fbcf8134e1bcad6c307400c2e13557fec`
- `admin-whatsapp-control.js`: `93dc3590fd7a0ef9c645186a455b9c1056ff7edb`
- `Dockerfile`: `f956d43df7a9fc41a635bb0032deeab4e1e990c4`
- `docker-compose.whatsapp-control.yml`: `4e2668059af9421dce5a7a745509a39ce17ea812`
- gateway n8n: `5a1dd255417a39d068d38d58c2d36dde34c6eda7`
- `tests/whatsapp-admin-control.test.js`: `cf6aee2c80a44222dedab5c9a80b7cc8844b2324`
- `whatsapp.html`: `1832eb297629089d057784e8325c8d5a788f6489`
- `netlify.toml`: `23d30e128003399ac701e33f499b46e8fbeeb710`
- instalador pausado: `f072ff7ee6098fda178a91dcf55bbb0f0da3b93d`
- rollback: `863df80ce7ed8eede087598acf247464f2f86422`

## Batería principal repetida 100 veces

Comando equivalente:

```text
node --test tests/whatsapp-admin-control.test.js
```

Resultado final después de las correcciones:

```text
100/100 iteraciones PASS
20 subtests por iteración
2.000 ejecuciones de subtests
0 fallos
```

Cada iteración incluye además bucles internos de 100 casos y una comprobación completa de los 1.440 minutos del día.

Cobertura relevante:

- barrera 08:00–21:00;
- 1.440 minutos del día;
- 100 configuraciones válidas consecutivas;
- 100 configuraciones fuera de horario rechazadas;
- 100 desplazamientos de warmup;
- 100 comparaciones de normalización Netlify/controlador;
- 100 escaneos de secretos y `forcePlan:true`;
- modo seguro inicial PAUSADO;
- gateway n8n inactivo y con Header Auth;
- ausencia de llamadas financieras en la nueva UI;
- redirección del panel WhatsApp viejo;
- conservación del backend histórico;
- puerto de diagnóstico ligado a loopback.

## Pruebas HTTP del controlador con agente falso

Se levantó el `controller.js` real contra un agente local simulado, ambos sin credenciales reales.

Resultado:

```text
100/100 health checks PASS
100/100 status autenticados PASS
100/100 tokens incorrectos rechazados con 401
100/100 run-now nocturnos rechazados con 409
0 llamadas /tick llegaron al agente durante esos 100 intentos nocturnos
1 warmup ejecutado y sesión simulada loggedIn=true
```

Esto verifica de extremo a extremo dentro del laboratorio que la barrera nocturna del controlador evita llegar al agente.

## Pruebas del relay Netlify simulado

Con `fetch` sustituido por un upstream controlado:

```text
100/100 run-now sin confirmación bloqueados antes del relay
100/100 horarios 21:00 bloqueados antes del relay
100/100 run-now confirmados generaron el contrato correcto
100/100 status generaron el contrato correcto
```

El encabezado de control se envía únicamente desde backend. No se expone el secreto al frontend.

## Edge/UI

Se ejecutó la Edge Function real con respuestas HTML sintéticas:

```text
100/100 inyecciones PASS
1/1 prueba de idempotencia PASS
```

Se verificó:

- un único módulo visible de WhatsApp;
- sección `#whatsapp-control`;
- endpoint backend correcto;
- eliminación de `content-length` después de modificar HTML;
- encabezado técnico de control;
- no duplicación si el HTML ya contiene el módulo.

## Instalador simulado 100 veces

Se ejecutó el instalador real contra 100 árboles `$HOME/n8n` desechables, con Docker/curl simulados.

Cada árbol comenzó con:

- agente existente con marcador único;
- estado del agente único;
- controlador previo en `automatic`;
- horario previo diferente;
- token falso de longitud válida.

Resultado:

```text
100/100 instalaciones PASS
100/100 respaldos creados antes de instalar
100/100 controladores forzados a PAUSADO
100/100 horarios previos preservados
100/100 archivos del agente intactos
100/100 estados del agente intactos
100/100 arranques usando --no-deps y solo whatsapp-controller
```

## Rollback simulado 100 veces

Sobre los mismos 100 entornos:

```text
100/100 rollbacks PASS
100/100 agentes intactos
100/100 estados de agente intactos
100/100 archivos de diagnóstico archivados
100/100 overlays del controlador retirados
```

## Parsers y sintaxis

Resultado:

```text
controller.js JS parse PASS
whatsapp-control.js JS parse PASS
admin-whatsapp-control.js ESM parse PASS
gateway n8n JSON parse PASS
bootstrap JSON parse PASS
netlify.toml TOML parse PASS
docker-compose YAML parse PASS
INSTALAR_CONTROLADOR_PAUSADO.command shell syntax PASS
ROLLBACK_CONTROLADOR.command shell syntax PASS
```

## Defectos encontrados durante pruebas y corregidos

### 1. Warmup potencialmente más largo que la petición Admin

Corrección: warmup pasó a ejecutarse en cola asíncrona y el panel consulta estado.

### 2. Operaciones concurrentes run/warmup

Corrección: reserva de operación, serialización y estado `runInProgress` / `warmupInProgress`.

### 3. Reintentos programados demasiado agresivos

Corrección: ledger de retry con espera de cinco minutos y supresión de revisiones superseded.

### 4. Instalador podía dejar permisos incorrectos en subdirectorios del backup

Corrección: directorios 700 y archivos 600 por separado.

### 5. Instalación previa podía conservar modo automático

Corrección: el instalador conserva configuración/horarios, pero fuerza `mode=paused` antes de levantar el contenedor.

### 6. Archivos temporales de health podían quedar de una ejecución anterior

Corrección: se eliminan antes de validar el nuevo proceso.

### 7. Horario inválido era bloqueado, pero reportado como 502

Corrección: errores de validación se clasifican como HTTP 400. La prueba relay se repitió 100 veces después de la corrección.

## Aislamiento del proyecto

La comparación contra el backup debe mostrar únicamente:

- `netlify.toml`, con la declaración de la Edge WhatsApp;
- `netlify/edge-functions/admin-whatsapp-control.js`;
- `netlify/functions/whatsapp-control.js`;
- `ops/whatsapp-control/**`;
- `tests/whatsapp-admin-control.test.js`;
- `whatsapp.html`.

Se verificó por SHA que estos archivos críticos existentes permanecen idénticos al baseline:

- `admin.html`;
- `admin-premium.js`;
- `netlify/functions/whatsapp-jobs.js`;
- `netlify/functions/admin-data.js`;
- `netlify/functions/monthly-close.js`.

## Lo que todavía NO está certificado

No se afirma que la nueva interfaz esté operativa en producción porque deliberadamente todavía no se ha hecho:

- instalación en la Mac mini real;
- creación del secreto nuevo Netlify → n8n;
- importación/publicación del gateway n8n;
- configuración de variables nuevas de Netlify;
- deploy de la rama;
- smoke test del Admin productivo;
- corte del planificador viejo;
- observación del primer ciclo automático con la nueva capa.

Esos pasos se ejecutan únicamente bajo `CUTOVER_DALE_PLAY.md` después de autorización expresa.

## Conclusión de esta fase

La **preparación offline** superó las pruebas repetitivas y simulaciones definidas y tiene rollback preparado.

Esto no convierte la integración productiva en “lista” por decreto: el gate de producción permanece cerrado hasta `DALE PLAY` y hasta observar el primer ciclo real posterior al corte.