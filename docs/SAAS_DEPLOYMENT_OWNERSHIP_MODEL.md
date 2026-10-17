# VLA SaaS — Modelo de propiedad y despliegue por condominio

## Objetivo

La plataforma comercial no debe depender de una cuenta personal del desarrollador/fundador ni obligar a todos los clientes a compartir una misma infraestructura de datos.

Se adopta el principio:

**Un solo producto y un solo código fuente, con infraestructura de datos separable por condominio.**

## Modelo recomendado para el lanzamiento

### Código
- Un repositorio/código canónico de la plataforma.
- Versiones y migraciones compartidas.
- Ningún fork manual por cliente salvo excepciones justificadas.

### Datos
- Cada condominio puede operar en un proyecto Supabase independiente.
- Cada proyecto contiene su propio Postgres, Auth, Storage, RLS y funciones/integraciones requeridas.
- Los usuarios de un condominio no existen automáticamente en el proyecto de otro condominio.

### Propiedad
Se soportarán tres modos:

1. **Managed Shared / Starter**
   - La empresa de software administra la infraestructura.
   - Puede usarse para desarrollo/demo y clientes pequeños cuando sea conveniente.
   - No será el único modo disponible.

2. **Dedicated Managed**
   - Un proyecto Supabase exclusivo para el condominio.
   - La empresa de software administra el proyecto y soporte.
   - Billing de infraestructura puede incorporarse a la mensualidad del servicio.

3. **Client Owned / Enterprise**
   - El condominio o administradora crea/posee su propia organización Supabase.
   - La empresa de software recibe acceso administrativo/técnico necesario para instalar, actualizar y dar soporte.
   - El cliente controla billing y propiedad de la organización/proyecto.
   - Si el proyecto fue creado inicialmente por la empresa de software, podrá transferirse posteriormente a la organización del cliente siguiendo el mecanismo oficial de transferencia de proyectos de Supabase.

## Regla para el piloto

Durante desarrollo puede usarse infraestructura temporal/staging de la empresa, pero ningún cliente comercial quedará permanentemente atado a una cuenta personal de Enzo Panarito.

Cuando un piloto se convierta en cliente:

- se crea o identifica la organización Supabase legítima del cliente;
- se despliega un proyecto dedicado o se transfiere el proyecto existente;
- el cliente queda como Owner de su organización cuando se contrate modalidad Client Owned;
- la empresa conserva solo el rol necesario para operación y soporte.

## Arquitectura de aplicación

La aplicación debe separar el `control plane` del `data plane`.

### Control plane
Mantiene únicamente información operacional de la plataforma:
- identificador de cliente;
- dominio/subdominio;
- versión desplegada;
- región;
- estado del servicio;
- referencia segura al proyecto de datos;
- plan comercial y módulos habilitados.

No debe almacenar el ledger financiero detallado de los condominios.

### Data plane por condominio
Cada proyecto Supabase puede contener:
- units;
- people;
- memberships;
- charges;
- payments;
- payment_allocations;
- credits;
- receipts;
- monthly_closes;
- access_events;
- notification_jobs;
- audit_events;
- settings;
- Storage privado de comprobantes/documentos;
- Auth propio del cliente.

## Despliegue inicial

Para simplificar la primera fase, cada condominio podrá tener:

- el mismo repositorio/código;
- un despliegue web independiente generado desde ese código;
- variables de entorno propias;
- su propia URL/publishable key de Supabase;
- credenciales server-side exclusivas;
- su propio dominio o subdominio.

Ejemplo:

```
app.vla.example            -> Supabase VLA
residencias-acacias.example -> Supabase Acacias
edificio-orion.example      -> Supabase Orion
```

No se deben incluir claves secretas de proyectos en el frontend. Las credenciales privilegiadas permanecerán solo en entornos server-side seguros.

## Evolución

Cuando haya volumen suficiente, el aprovisionamiento podrá automatizarse mediante Supabase Management API / OAuth y mecanismos de project claim/transfer, de forma que el cliente pueda crear o reclamar su infraestructura sin procesos manuales complejos.

## Portabilidad y salida

El contrato técnico debe permitir:
- exportar la base de datos y documentos del cliente;
- transferir un proyecto Supabase a otra organización cuando sea elegible;
- revocar acceso de la empresa al terminar el servicio;
- mantener el código fuente propietario de la plataforma separado de los datos del cliente.

## Decisión

**El producto no dependerá de una cuenta personal de Supabase.**

La modalidad preferida para clientes comerciales que requieren independencia será un **proyecto Supabase dedicado por condominio**, idealmente dentro de una organización propiedad del cliente o transferible a ella. El código y las actualizaciones permanecerán centralizados en la plataforma para evitar mantener una versión manual distinta por cada condominio.