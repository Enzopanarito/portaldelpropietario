# Respaldo previo al rediseño administrativo

- **Fecha:** 12 de julio de 2026
- **Hora:** 00:15 (America/New_York / America/Caracas)
- **Tipo de modificación:** Rediseño visual premium del portal administrativo y sesión administrativa única.
- **Rama de respaldo:** `backup-2026-07-11-2345-admin-redesign-single-session`
- **Rama de trabajo:** `redesign-admin-2026-07-11-premium-single-session`
- **Commit base protegido:** `5667973295d284d7a1ed7dd73908d90639e342e8`

## Alcance protegido

La modificación no altera saldos, pagos, gastos, cierre mensual, recibos, correos, tasa BCV ni reglas del portón. El rediseño se aplica como una capa visual externa sobre las funciones existentes. La sesión compartida sincroniza el token administrativo entre Admin, Portón, Seguridad, Auditoría y Comunicaciones, respetando el vencimiento del token y limpiándolo ante una respuesta 401.

## Reversión

Para revertir completamente, restaurar la rama de respaldo indicada o el commit base protegido.
