# Política de datos para staging

Staging existe para reproducir reglas y casos financieros, no identidades personales.

## Datos que se conservan

- número de casa;
- alícuota;
- saldos separados USD y Bs. BCV;
- importes, fechas y formas de pago;
- gastos comunes y especiales;
- estados necesarios para probar flujos;
- fotografías `CURRENT_BALANCE` de `ControlVersiones`.

## Datos que se sustituyen o eliminan

- nombre del propietario;
- teléfono;
- correo;
- referencias bancarias;
- identificadores y correos MKJ;
- comprobantes y otros adjuntos;
- bloqueos operativos, telemetría y marcadores de idempotencia de producción.

## Prohibiciones

- Un deploy preview no puede apuntar al Base ID de producción.
- El sincronizador no escribe en la base de origen.
- El modo por defecto es `plan`.
- `apply` solo puede usarse contra el Base ID staging y con confirmación exacta.
- Los resultados de staging no se consideran saldos oficiales ni pueden activar el portón real.
