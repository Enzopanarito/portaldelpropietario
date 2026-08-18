# Punto 9 · certificación financiera final

Registro operativo no ejecutable.

## Corrección identificada y aislada

El primer despliegue del Punto 9 cambió únicamente el cálculo visible de cuatro propietarios que mantenían saldo pendiente en Bs-ref. La variación fue de **-0,77** por propietario en Casa 3, Casa 10, Casa 12 y Casa 13.

La causa quedó trazada al gasto activo **SERVICIO TECNICO DE PLANTA ELECTRICA**:

- Tipo: `Gasto Especial`.
- Monto: 100 Bs BCV.
- Distribución: partes iguales entre 13 propietarios.
- Participación individual: 100 / 13 = 7,692307...
- 10%: 0,769230... = 0,77.

La versión anterior del motor estaba incluyendo esos 0,77 dentro del cálculo asociado al Beneficio de Pronto Pago. Esto contradecía la regla operativa vigente: **Gasto Común se distribuye por alícuota y es susceptible al Beneficio de Pronto Pago; Gasto Especial se distribuye por partes iguales y no es susceptible.**

No se modificó la categoría del gasto, Airtable, pagos, deuda anterior ni el cierre de agosto. La corrección se produjo al hacer que el motor respetara la clasificación que ya existía.

## Estabilidad posterior

Después del ajuste se capturó producción dos veces de forma independiente sobre los 10 campos financieros canónicos de las 15 casas. Ambas capturas fueron idénticas: **15/15 casas, 150/150 campos, diferencia $0.00**.

Este commit es exclusivamente documental y tiene como objetivo provocar una última ejecución del pipeline certificado sin modificar runtime ni lógica financiera. El criterio de aprobación vuelve a ser estricto: BEFORE/AFTER del despliegue final debe resultar en **150/150 campos y $0.00**.

El cierre real de agosto de 2026 permanece bloqueado hasta la ventana del 1 al 3 de septiembre, hora de Caracas.
