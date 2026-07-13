# Checklist de activación de Airtable staging

No ejecutar `apply` hasta completar todos los puntos.

- [ ] Duplicar la estructura de la base de producción en una base separada de Airtable.
- [ ] Confirmar que el Base ID staging es distinto del Base ID producción.
- [ ] Crear el environment protegido `staging` en GitHub.
- [ ] Configurar en ese environment: `AIRTABLE_API_TOKEN`, `AIRTABLE_PRODUCTION_BASE_ID` y `AIRTABLE_STAGING_BASE_ID`.
- [ ] Configurar en Netlify deploy previews: `VLA_DATA_ENVIRONMENT=staging`.
- [ ] Configurar en Netlify deploy previews: `AIRTABLE_BASE_ID` con el Base ID staging.
- [ ] Configurar en Netlify deploy previews: `AIRTABLE_PRODUCTION_BASE_ID` para que la guarda pueda detectar una fuga.
- [ ] Ejecutar primero el workflow `Seed Airtable Staging` en modo `plan`.
- [ ] Descargar y revisar el artefacto sanitizado.
- [ ] Verificar que no contiene nombres, teléfonos, correos, referencias reales ni identificadores MKJ.
- [ ] Ejecutar `apply` escribiendo exactamente `REPLACE_STAGING_ONLY`.
- [ ] Descargar y conservar el respaldo de la base staging anterior.
- [ ] Probar las 15 casas en el deploy preview.
- [ ] Confirmar que ninguna prueba generó pagos, reportes, cierres o acciones de portón en producción.
