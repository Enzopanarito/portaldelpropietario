# Punto 9 · retrigger de certificación de producción

Registro operativo no ejecutable.

- Motivo: el merge de PR #154 (`17c6d18b934a39199269247cc8a77f4e0f24d542`) quedó en `main`, pero el deploy de producción continuó sirviendo el commit anterior.
- Objetivo: provocar un nuevo `push` certificado a `main` mediante PR, sin modificar runtime, reglas financieras, Airtable, cierre mensual ni lógica Gasto Común/Gasto Especial.
- Regla de seguridad: producción solo se considera certificada si el workflow `Deploy Netlify Production` valida el commit exacto, Functions Node 24 y BEFORE/AFTER financiero 15/15 casas, 150/150 campos, diferencia absoluta $0.00.
- Agosto 2026 no debe cerrarse antes de la ventana real del 1 al 3 de septiembre (Caracas).
