# VLA SaaS — Modelo multi-condominio v1

## Objetivo

Convertir el sistema actual de Villas Los Apamates en una plataforma configurable para edificios, urbanizaciones, conjuntos residenciales, centros empresariales y comunidades mixtas, conservando el comportamiento financiero validado de VLA.

## Jerarquía principal

### Tenant
Cliente/comunidad contratante.

Campos conceptuales mínimos:
- `id`
- `legal_name`
- `display_name`
- `slug`
- `timezone`
- `primary_currency`
- `secondary_currency`
- `status`
- `branding_config`
- `created_at`

### Site
Representa una sede, urbanización, conjunto o complejo perteneciente a un tenant.

### Structure
Agrupador configurable: torre, sector, etapa, bloque, nivel u otra división.

### Unit
Entidad residencial/comercial neutral. En interfaz puede mostrarse como casa, apartamento, local, oficina o parcela.

Campos conceptuales mínimos:
- `id`
- `tenant_id`
- `site_id`
- `structure_id`
- `code`
- `display_name`
- `unit_type`
- `ownership_coefficient`
- `status`

### Person
Persona natural o jurídica.

### Unit membership
Relaciona personas y unidades con roles temporales:
- propietario
- copropietario
- inquilino
- residente
- representante
- autorizado

Debe admitir fecha de inicio/fin y evitar que el historial se pierda cuando cambia un propietario.

## Núcleo financiero

### Charge
Cargo emitido a una unidad o responsable. Debe soportar:
- cuota ordinaria;
- cuota extraordinaria;
- fondo;
- consumo/servicio;
- recargo;
- ajuste;
- cargo manual autorizado.

### Payment
Pago reportado o registrado, separado de su aplicación contable.

### Payment allocation
Distribuye un pago entre uno o varios cargos. Esta separación permitirá pagos parciales, pagos múltiples y conciliaciones sin reescribir el historial.

### Credit
Crédito a favor que no debe compensar silenciosamente obligaciones de otra moneda salvo regla explícita del tenant.

### Receipt
Documento emitido luego de un estado financiero válido.

### Exchange rate
Fuente y valor de tasa de cambio con sello temporal y procedencia.

### Monthly close
Cierre auditable por tenant y período.

## Configuración por tenant

Las reglas no estarán codificadas en el frontend. Deben vivir como configuración versionada:

### Financial settings
- día de emisión;
- día de vencimiento;
- pronto pago;
- recargo/mora;
- monedas habilitadas;
- fuente de tasa;
- política de créditos;
- reglas de redondeo;
- tipos de cuota;
- distribución por alícuota o monto fijo.

### Payment settings
- métodos habilitados;
- cuentas receptoras;
- requisitos de comprobante;
- revisión manual/automática;
- tolerancias;
- tratamiento de efectivo;
- reglas de duplicado e idempotencia.

### Access settings
- proveedor de acceso;
- condición de restricción;
- deuda vencida mínima;
- política de desbloqueo provisional;
- fail-safe;
- excepciones por unidad o persona.

### Notification settings
- email;
- WhatsApp;
- días de recordatorio;
- plantillas;
- horarios;
- consentimiento y preferencias.

## Integraciones desacopladas

El núcleo no dependerá directamente de proveedores concretos.

Interfaces conceptuales:
- `AccessProvider`
- `MessagingProvider`
- `ExchangeRateProvider`
- `PaymentEvidenceProvider`
- `DocumentStorageProvider`

MKJ será una implementación de `AccessProvider`, no una dependencia estructural del producto.

## Aislamiento y permisos

Todo registro operativo deberá incluir `tenant_id` directa o indirectamente verificable.

Roles iniciales:
- platform_admin
- tenant_owner
- tenant_admin
- accountant
- payment_reviewer
- security_operator
- board_member
- resident
- read_only_auditor

Las reglas RLS deberán comprobar tanto tenant como rol/relación con la unidad. Estar autenticado nunca será suficiente para leer registros de un tenant.

## Auditoría

`audit_events` será append-only para eventos sensibles:
- creación/edición/anulación de cargos;
- aprobación/rechazo de pagos;
- cambios de saldo derivados;
- cierres;
- cambios de configuración;
- cambios de permisos;
- acciones de acceso;
- importaciones;
- operaciones administrativas de alto impacto.

No almacenar comprobantes ni secretos dentro del evento; solo referencias seguras y metadatos mínimos.

## Estrategia del piloto

1. Crear tenant piloto.
2. Importar estructura, unidades, personas y saldos iniciales.
3. Ejecutar conciliación de apertura.
4. Mantener el sistema anterior en paralelo durante validación.
5. Habilitar portal y reportes de pago.
6. Activar automatizaciones por etapas.
7. Activar control de acceso solo después de certificar reglas financieras.
8. Documentar diferencias operativas para convertirlas en configuración genérica, no parches específicos.

## Principio de producto

Ningún requerimiento del segundo cliente debe implementarse como `if (cliente === ...)` salvo una integración externa estrictamente aislada. Si una regla puede variar entre comunidades, debe convertirse en configuración o política versionada.