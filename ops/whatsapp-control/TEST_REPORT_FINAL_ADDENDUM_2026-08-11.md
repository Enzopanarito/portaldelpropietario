# Addendum final de pruebas · WhatsApp Admin VLA

Fecha: 2026-08-11

Este addendum complementa `TEST_REPORT_2026-08-11.md` después de la última corrección visual para garantizar **un solo control WhatsApp visible** en el Admin premium.

## Revisión final probada

Archivo:

`netlify/edge-functions/admin-whatsapp-control.js`

Git blob SHA final:

`485b8e569223014df515cd6a0e37cf5c08442194`

La copia utilizada en el laboratorio produjo exactamente el mismo Git blob SHA antes de ejecutar las pruebas.

## Corrección final

Cuando el Admin premium crea su menú lateral y aparece el enlace histórico:

`/whatsapp.html` → `Comunicaciones`

la capa WhatsApp ahora:

1. elimina el botón WhatsApp de fallback que pudo haberse inyectado en el menú base;
2. reutiliza el enlace premium existente;
3. cambia su destino a `#whatsapp-control`;
4. cambia su etiqueta visible a `WhatsApp`;
5. mantiene el panel antiguo `whatsapp.html` únicamente como redirección de compatibilidad.

Por tanto, el Admin premium conserva **un solo punto visible de entrada a WhatsApp**.

El botón base solo existe como fallback si, por alguna falla independiente, el shell premium no llega a construirse.

## Batería completa posterior a la corrección

Se repitió la batería completa:

```text
100/100 iteraciones PASS
20 subtests por iteración
2.000 ejecuciones de subtests
0 fallos
```

La batería corresponde a la copia cuyo SHA de `admin-whatsapp-control.js` coincide con el SHA final indicado arriba.

## Prueba específica de control único premium

Se ejecutaron 100 montajes sintéticos independientes del menú premium, cada uno con:

- enlace histórico `/whatsapp.html` presente;
- botón fallback `data-target='whatsapp-control'` presente;
- llamada a la lógica final `wirePremiumLink()`.

Resultado:

```text
100/100 PASS
100/100 botones fallback eliminados
100/100 enlaces premium reescritos a #whatsapp-control
100/100 etiquetas/control premium cableados
```

## Estado del gate

Estas pruebas siguen siendo offline/simuladas.

No se ha realizado:

- merge a `main`;
- deploy de Netlify;
- instalación del controlador en la Mac mini productiva;
- importación/publicación del gateway n8n nuevo;
- cambio de variables/credenciales productivas;
- desactivación del workflow actual;
- envío de WhatsApp real desde la nueva capa.

El gate productivo permanece cerrado hasta autorización expresa `DALE PLAY` y se ejecutará siguiendo `CUTOVER_DALE_PLAY.md`.