# VLA SaaS — Decisión de arquitectura de datos

## Estado

**Decisión:** usar PostgreSQL administrado mediante **Supabase** como base de datos principal de la versión comercial multi-condominio.

**Airtable:** se mantiene sin cambios para Villas Los Apamates mientras dure la transición y puede conservarse como herramienta auxiliar de backoffice/importación, pero no será el ledger ni la fuente canónica del SaaS.

## Razones

### 1. Multi-tenancy real
Cada registro comercial deberá pertenecer a un `tenant_id` (condominio/comunidad). PostgreSQL permite reforzar este aislamiento en la propia base mediante Row Level Security (RLS), además de los controles del backend.

### 2. Integridad financiera
Cargos, pagos, créditos, cierres, conciliaciones y recibos requieren transacciones, restricciones, claves foráneas, índices y auditoría consistentes. Estas garantías deben residir en el motor de datos y no depender únicamente de lógica de aplicación.

### 3. Escalabilidad
El producto debe soportar desde comunidades pequeñas hasta edificios con cientos o miles de unidades y, posteriormente, administradoras con múltiples comunidades. El almacenamiento y las consultas no deben depender de límites por base ni de un modelo de API pensado principalmente para workflows colaborativos.

### 4. Autenticación, archivos y seguridad
Supabase permite integrar PostgreSQL, Auth, Storage, APIs y funciones de servidor con una política de seguridad común. Los comprobantes y documentos seguirán protegidos y nunca serán públicos por defecto.

### 5. Portabilidad
El núcleo seguirá siendo PostgreSQL estándar. La lógica crítica no debe depender de extensiones propietarias innecesarias para permitir migración futura si el producto lo requiere.

## Estrategia de transición

1. **No tocar producción VLA.** `main` continúa utilizando la infraestructura existente.
2. Construir la plataforma comercial en la rama `product/multitenant-saas-foundation`.
3. Crear el esquema SaaS neutral: tenants, sites, units, people, memberships, charges, payments, allocations, receipts, audit_events, integrations y settings.
4. Implementar el edificio piloto inicialmente aislado del VLA productivo.
5. Crear herramientas de importación y conciliación desde CSV/Airtable.
6. Validar que cada saldo importado sea idéntico al sistema de origen antes de activar operaciones.
7. Solo después de validar el nuevo núcleo, migrar Villas Los Apamates como un tenant adicional.

## Papel futuro de Airtable

Airtable puede seguir usándose opcionalmente para:

- CRM de clientes y prospectos.
- seguimiento de onboarding;
- tableros operativos internos;
- importaciones temporales;
- soporte y tareas humanas.

No debe ser fuente canónica para:

- ledger financiero;
- autenticación;
- aislamiento entre condominios;
- permisos de propietarios;
- cierres contables;
- control de acceso;
- auditoría de seguridad.

## Regla de arquitectura

Todo módulo nuevo deberá poder determinar explícitamente el `tenant_id` antes de leer o escribir datos del negocio. Ningún identificador de unidad, propietario, pago o integración será global por sí solo.

## Compatibilidad

El motor financiero VLA v7 se preservará como referencia de comportamiento. La migración no puede alterar la semántica actual de saldos USD/Bs, créditos, total pagadero, cierre mensual, idempotencia o auditoría.