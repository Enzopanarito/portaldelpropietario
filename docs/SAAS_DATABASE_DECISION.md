# VLA SaaS — Decisión de arquitectura de datos

## Estado

**Decisión:** usar PostgreSQL administrado mediante **Supabase** como base de datos principal de la versión comercial multi-condominio.

**Airtable:** se mantiene sin cambios para Villas Los Apamates mientras dure la transición y puede conservarse como herramienta auxiliar de backoffice/importación, pero no será el ledger ni la fuente canónica del SaaS.

## Política de costos: Free-first

La plataforma comercial se desarrollará y validará inicialmente **sin costos fijos de infraestructura** siempre que los límites técnicos lo permitan.

Reglas:

1. Construir sobre el plan gratuito de Supabase durante desarrollo y primer piloto.
2. No activar add-ons, dominios de pago, backups avanzados, PITR, compute adicional ni otras capacidades facturables durante esta fase.
3. No subir de plan por anticipación. El upgrade se realizará únicamente cuando el consumo real o las necesidades operativas de uno o más condominios lo justifiquen.
4. El código deberá ser portable entre Free y Pro sin bifurcar la aplicación ni alterar el modelo de datos.
5. El sistema deberá registrar métricas de uso por tenant para saber qué cliente está generando base de datos, almacenamiento, egress, funciones y actividad.
6. Cuando un cliente haga necesario un plan superior, ese costo deberá incorporarse al precio comercial del servicio y no absorberse de forma indefinida como costo oculto.

### Límites de diseño para la fase gratuita

A fecha de octubre de 2026, Supabase Free ofrece por proyecto, entre otros recursos, 500 MB de base de datos, 1 GB de Storage, 5 GB de egress, 50.000 usuarios activos mensuales, 500.000 invocaciones de Edge Functions y APIs sin límite de llamadas. Los proyectos gratuitos pueden pausarse por inactividad.

La arquitectura deberá mantenerse por debajo de estos límites durante desarrollo y piloto, evitando almacenar binarios grandes dentro de PostgreSQL y aplicando políticas de retención a archivos no esenciales.

### Disparadores de upgrade

Evaluar paso a Pro cuando ocurra cualquiera de estos casos:

- La base se acerque de forma sostenida al 70–80 % del límite gratuito.
- Storage o egress se acerquen al límite y la reducción razonable de consumo no sea suficiente.
- El proyecto ya sea operación comercial crítica y necesite backups automáticos, mayor disponibilidad operativa o evitar pausas por inactividad.
- El número de comunidades/clientes activos justifique separar infraestructura o aumentar capacidad.
- El rendimiento medido en producción deje de cumplir los objetivos de respuesta definidos para propietarios y administradores.

El upgrade no cambia el modelo multi-tenant ni requiere reconstruir la aplicación; únicamente aumenta los recursos y capacidades disponibles.

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