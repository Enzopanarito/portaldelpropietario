# Conector local de WhatsApp — Villa Los Apamates

## Estado actual

Este componente está en desarrollo y certificación dentro del PR de integración. El envío real permanece bloqueado por el servidor.

No utiliza:

- API oficial de WhatsApp;
- PyWhatKit;
- PyAutoGUI;
- AppleScript para simular teclado;
- Playwright como navegador principal;
- un servidor local abierto en la Mac.

Usa Google Chrome normal, una extensión privada limitada a `web.whatsapp.com` y el protocolo Native Messaging de Chrome.

## Arquitectura

```text
Portal administrativo autorizado
        ↓ permiso temporal de un solo lote
Extensión privada de Chrome
        ↓ Native Messaging
VLAWhatsAppHost en la Mac
        ↓ HTTPS
Funciones protegidas de Netlify
        ↓ cola atómica
Netlify Blobs + espejo de auditoría en Airtable
```

La extensión separa cada envío en dos fases:

1. **Preparar**: abre el destinatario, espera WhatsApp, comprueba teléfono, texto y hash. No pulsa Enviar.
2. **Confirmar**: después de que el servidor registra `Enviando`, vuelve a comprobar la pantalla, pulsa Enviar y busca evidencia de una nueva burbuja saliente y del editor vacío.

Si la confirmación es dudosa, el resultado es `Verificar`. Nunca se reenvía automáticamente.

## Interruptores de seguridad

Los tres deben habilitarse deliberadamente en Netlify:

- `WHATSAPP_QUEUE_ENABLED=true`: permite crear y modificar lotes.
- `WHATSAPP_CONNECTOR_ENABLED=true`: permite que el host Mac reclame lotes.
- `WHATSAPP_REAL_SEND_ENABLED=true`: permite marcar y ejecutar envíos reales.

Durante desarrollo y preview deben permanecer desactivados. La simulación del navegador tampoco debe considerarse una certificación real de WhatsApp.

## Instalación de desarrollo en una Mac autorizada

Requisitos:

- macOS 13 o posterior;
- Google Chrome instalado en `/Applications`;
- herramientas de línea de comandos de Xcode con Swift;
- copia exacta del código correspondiente al head certificado.

Desde Terminal:

```bash
cd mac-connector
bash scripts/install.sh
```

El instalador:

- crea un respaldo de la instalación anterior;
- compila y prueba el código en la propia Mac;
- instala el host con permisos restringidos;
- crea la aplicación de barra de menú;
- registra Native Messaging para un único ID de extensión;
- conserva la identidad y los registros al actualizar;
- no utiliza `sudo`.

Chrome requiere una autorización manual inicial:

1. Abrir `chrome://extensions`.
2. Activar **Modo de desarrollador**.
3. Pulsar **Cargar extensión sin empaquetar**.
4. Seleccionar la carpeta mostrada por el instalador.
5. Confirmar este ID exacto:

```text
oopmhhmkihemkkjghmpepgfcmcomplph
```

6. Abrir `https://web.whatsapp.com` y vincular la sesión si hace falta.

## Desinstalación y rollback

Desinstalar conservando identidad, logs y respaldos:

```bash
bash scripts/uninstall.sh
```

Borrar también datos locales, solo mediante decisión expresa:

```bash
bash scripts/uninstall.sh --purge-data
```

Restaurar la instalación anterior más reciente:

```bash
bash scripts/rollback-latest.sh
```

## Datos locales

Se guardan bajo:

```text
~/Library/Application Support/Villas Los Apamates/WhatsApp Connector
```

Los archivos de identidad, estado y logs usan permisos restringidos. Los logs no deben contener textos de mensajes, teléfonos completos, contraseñas ni tokens.

## Compilación y pruebas

```bash
swift test
swift build -c release --product VLAWhatsAppHost
swift build -c release --product VLAWhatsAppMenu
node ../tests/mac-connector-static.test.js
```

GitHub Actions ejecuta además una compuerta independiente sobre `macos-14`.

## Certificación obligatoria antes de habilitar envío real

1. Exportar y verificar el respaldo completo del portal y Airtable.
2. Comparar las 15 casas contra la línea base financiera.
3. Instalar el head exacto en la Mac autorizada.
4. Confirmar extensión, host y aplicación de barra.
5. Ejecutar un lote exclusivamente en simulación.
6. Verificar pausa, continuación, cancelación y recuperación tras caída.
7. Ejecutar una prueba real a un número autorizado por Enzo.
8. Comprobar manualmente el chat y la evidencia registrada.
9. Confirmar que una pérdida de conexión posterior al clic termina en `Verificar`.
10. Repetir la comparación de saldos y verificar portal público, administrador, portón y cierres.

Solo después de esas compuertas puede evaluarse habilitar `WHATSAPP_REAL_SEND_ENABLED`.

## Distribución final

El paquete actual de CI es de certificación y no está firmado ni notarizado. La entrega final deberá producir una aplicación y un instalador firmados/notarizados con credenciales de Apple, sin compartir certificados ni claves privadas en el repositorio.
