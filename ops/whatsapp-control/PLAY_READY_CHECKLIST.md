# VLA WhatsApp Admin · PLAY READY

Estado: **preparado para autorización final de producción**. Este documento no autoriza merge ni deploy.

## Estado operativo validado

- Admin WhatsApp: Operativo.
- Sesión WhatsApp: Vinculado.
- Modo: AUTOMÁTICO.
- Agente: REAL.
- Planificador: ACTIVO.
- Horarios: 09:00 y 18:00, America/Caracas.
- Ventana fija de inicio de envíos: 08:00–20:59.
- `forcePlan:false` obligatorio.
- Scheduler viejo de n8n: despublicado.
- Gateway Admin: publicado/activo.
- Un solo scheduler efectivo: Controller.
- Agente local: 1.3.1 con re-vinculación y autorreparación Singleton.
- Docker agente: `init=true`.
- `WA_STARTUP_RECOVERY=false` persistente.

## Re-vinculación sin Terminal

- Admin detecta sesión desconectada.
- Ofrece `Volver a vincular WhatsApp`.
- QR efímero visible solo en Admin autenticado.
- QR no se guarda en `localStorage`, `sessionStorage`, auditoría ni runtime persistente.
- Transporte QR cifrado: AES-256-GCM + RSA-OAEP-SHA256.
- Durante vinculación: scheduler, warmup y RUN NOW bloqueados.
- Finalizada la vinculación: QR desaparece y el estado se refresca.

## Autorreparación Chromium validada en vivo

- Detecta Singleton huérfano antes de `launchPersistentContext`.
- Socket o Chromium vivo: preservar y no tocar.
- Estado ambiguo: fail closed.
- Lock de contenedor anterior, PID inexistente o zombie, sin socket vivo: respaldar y retirar solo `SingletonLock`, `SingletonSocket`, `SingletonCookie`.
- Nunca borrar perfil, `Default`, cookies ni `Local State`.
- Backup automático: `/data/singleton-backups-auto/`.
- Validación real 11/08/2026 22:52: verificación solicitada 22:52:34, resultado Correcto 22:52:39, sesión Vinculado y sin incidencias activas.

## Baseline financiero protegido

Fuente de producción capturada: 12/08/2026 02:47:32Z.

- Base commit: `ee7baa4d7eeefaf4d6c7c66835fd7d1c58695ff6`.
- Release: `2026-08-09-v9`.
- Casas: 15/15.
- Campos financieros capturados: 150.
- Total `totalPagadero`: **$1,027.01**.

Regla absoluta de despliegue: el AFTER debe producir **delta financiero exactamente $0.00** respecto al BEFORE inmediatamente anterior al merge. Cualquier diferencia implica ABORTAR.

## Gates obligatorios antes de merge

1. PR actual mergeable y todos los workflows verdes.
2. Deploy Preview desktop validado.
3. Contrato responsive del Admin WhatsApp y relink validado por tests.
4. Prueba segura real desde Admin: `Pausar` y luego `Reanudar automático`, sin RUN NOW; estado final obligatorio AUTOMÁTICO + REAL + ACTIVO.
5. Capturar un baseline financiero BEFORE nuevo inmediatamente antes del merge.
6. Confirmar que `main` no cambió respecto del baseline esperado; si cambió, reauditar antes de continuar.
7. Recibir autorización expresa de merge/despliegue.

## Cutover de producción

1. Confirmar HEAD exacto del PR y CI verde.
2. Confirmar baseline BEFORE de 15 casas.
3. Merge una sola vez.
4. Un único deploy de producción.
5. Smoke de propietario.
6. Smoke de Admin.
7. Verificar WhatsApp: AUTOMÁTICO + REAL + ACTIVO + Vinculado.
8. Confirmar gateway publicado y scheduler viejo despublicado.
9. Capturar AFTER de los mismos 150 campos financieros.
10. Calcular delta BEFORE/AFTER.
11. Solo aceptar si delta = `$0.00` y 0 casas cambiaron por efecto del despliegue.

## ABORTAR inmediatamente si

- CI no está completamente verde.
- PR HEAD cambió sin revalidación.
- `main` cambió inesperadamente.
- Producción devuelve menos de 15 casas.
- Baseline financiero no puede capturarse.
- Delta financiero BEFORE/AFTER es distinto de `$0.00`.
- Agente no está REAL.
- Controller no está AUTOMÁTICO al final.
- Gateway no está publicado o el scheduler viejo vuelve a estar activo.
- Existe incertidumbre sobre un envío, un ciclo o una sesión WhatsApp.

## Prohibido durante pruebas

- No ejecutar RUN NOW real solo para probar.
- No provocar artificialmente una desconexión de WhatsApp para ver el QR.
- No modificar saldos, pagos, cierres, pronto pago, gasoil, comprobantes, MKJ/portón ni lógica financiera.
- No mostrar, regenerar ni registrar secretos operativos.

Resultado esperado al recibir autorización final: **un solo merge, un solo deploy y verificación AFTER con delta $0.00**.
