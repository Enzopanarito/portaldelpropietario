# Blueprint de comercialización Suramérica

## Objetivo

Transformar el sistema originado en Villas Los Apamates en una plataforma regional de gestión residencial/condominial preparada para ser distribuida en Suramérica, con integración preferente a tecnología de control de acceso MKJOULES y sin acoplar el núcleo a una legislación, moneda, medio de pago o proveedor de hardware específico.

## Tesis de producto

La oportunidad no consiste en vender otro software de administración de condominios. En mercados como Brasil, Chile, Argentina y Perú ya existen plataformas consolidadas con finanzas, comunicaciones, reservas, pagos y apps para residentes.

El posicionamiento diferencial debe ser:

**Sistema operativo de la comunidad residencial: finanzas + cobranza + residentes + comunicaciones + automatización + control de acceso físico + IA + auditoría.**

El circuito distintivo debe ser completo:

`cargo -> cobranza -> pago -> evidencia -> validación -> saldo -> política de mora -> comunicación -> acceso -> auditoría`

Nunca se debe convertir una regla local de Villas Los Apamates en comportamiento global sin parametrización.

## Arquitectura regional

### 1. Core regional

El Core será jurídicamente y técnicamente neutral respecto del país. Debe contener:

- personas y organizaciones;
- comunidades/condominios;
- estructuras y unidades;
- propietarios, residentes, arrendatarios y autorizados;
- ledger financiero;
- cargos y pagos;
- créditos y aplicaciones de pago;
- recibos;
- documentos;
- comunicaciones;
- reservas;
- incidencias;
- control de acceso abstracto;
- auditoría;
- permisos;
- automatizaciones;
- API e integraciones.

### 2. Country Pack

Cada país habilita un `Country Pack` versionado que define, sin modificar el Core:

- código ISO de país;
- idioma(s);
- zona(s) horaria(s);
- moneda(s) y reglas de precisión;
- terminología local (`condominio`, `consorcio`, `copropiedad`, `expensa`, `gasto común`, `cuota de mantenimiento`, etc.);
- documentos fiscales y de identidad;
- proveedores/tasas de cambio;
- medios de pago y conciliación;
- reglas de documentos/recibos;
- retención de datos;
- consentimientos y textos de privacidad;
- requisitos de exportación/portabilidad;
- restricciones regulatorias de módulos;
- configuración legal de cobranza, mora y acceso;
- proveedores de mensajería;
- formatos de teléfono, dirección y fecha.

Las reglas legales no serán hardcodeadas. Cada Country Pack tendrá versión y fecha de vigencia.

### 3. Tenant Policy

Dentro de cada país, cada comunidad aplica políticas propias:

- vencimiento;
- pronto pago;
- mora/recargo;
- moneda;
- coeficientes/alícuotas;
- métodos de pago;
- reservas;
- acceso;
- notificaciones;
- roles;
- excepciones.

Jerarquía:

`Core -> Country Pack -> Tenant Policy`

Una política del tenant nunca puede habilitar algo prohibido por el Country Pack aplicable.

## Desacople del control de acceso

MKJOULES será el `AccessProvider` preferente y estratégico, pero no una dependencia del Core.

Interfaces mínimas:

- alta/baja de credencial;
- habilitar/deshabilitar usuario;
- sincronizar unidad/persona;
- abrir acceso remoto cuando esté autorizado;
- consultar estado del dispositivo;
- descargar/recibir eventos;
- reconciliar estado local vs proveedor;
- health check;
- idempotencia;
- fail-safe.

El modelo debe aceptar futuras implementaciones para MKJOULES, Wiegand genérico, Hikvision, ZKTeco, QR, LPR/placas, biometría y proveedores locales.

### Regla de privacidad para biometría

Siempre que sea técnicamente posible, la plataforma no almacenará plantillas biométricas crudas. El proveedor/controlador físico conservará el dato biométrico y nuestro sistema almacenará únicamente un identificador externo, autorización y evento de acceso. Esto reduce riesgo regulatorio y de seguridad.

## Control Plane y Data Plane

### Control Plane de la plataforma

Administrado por la empresa de software/JV. Mantiene únicamente:

- ID de cliente;
- país;
- distribuidor/canal;
- licencia;
- módulos habilitados;
- versión de plataforma;
- versión de Country Pack;
- dominio;
- estado operativo;
- referencia al proyecto de datos;
- métricas agregadas no sensibles;
- facturación/licenciamiento;
- soporte y SLA.

No almacena el ledger detallado de cada comunidad.

### Data Plane del cliente

Preferentemente un proyecto Supabase dedicado por comunidad o por organización administradora, propiedad del cliente o transferible a éste:

- PostgreSQL;
- Auth;
- Storage;
- RLS;
- funciones;
- datos financieros;
- residentes;
- documentos;
- eventos de acceso;
- auditoría.

El software permanece centralizado; los datos permanecen separables y portables.

## Modelo de distribución

La plataforma debe admitir cuatro canales:

1. venta directa a una comunidad;
2. empresa administradora de múltiples comunidades;
3. distribuidor/instalador de seguridad y control de acceso;
4. inmobiliaria/desarrollador que entrega comunidades nuevas.

MKJOULES encaja especialmente en el canal 3 y puede acelerar 1 y 2 mediante su red técnica.

## Modelo de white-label

Soportar desde el inicio:

- marca de plataforma principal;
- marca del distribuidor;
- logo/color de la comunidad;
- dominio/subdominio propio;
- emails y plantillas por canal;
- app/PWA con identidad configurable.

El white-label nunca debe producir forks manuales del código.

## Mercado y benchmark observado (2026)

Competidores relevantes muestran que el mercado ya espera:

- finanzas y cobranza;
- conciliación bancaria;
- app/portal de residentes;
- reservas;
- comunicaciones;
- incidencias;
- acceso/portería;
- multi-comunidad para administradoras;
- IA creciente.

Referencias observadas:

- ComunidadFeliz (Chile/LatAm): miles de comunidades, finanzas, pagos, IA y acceso automatizado.
- TownSq (Brasil y otros mercados): decenas de miles de condominios, finanzas, comunicación, operaciones y autorizaciones de acceso.
- ConsorcioAbierto (Argentina): expensas, gestión administrativa/financiera e IA.
- Condo / Cuotafy / Condomio (Perú): acceso, cobranzas, WhatsApp/IA, reservas y multi-edificio.

Conclusión: no competir por checklists de funciones. Competir por integración operacional real entre administración y acceso físico, automatización, auditabilidad y despliegue regional.

## Prioridad geográfica sugerida

### Ola 0 — Venezuela

Objetivo: certificar el producto con MKJOULES donde ya existe integración y canal conocido.

- Venezuela
- VLA como referencia funcional, no como arquitectura definitiva.
- Primer edificio piloto externo.

### Ola 1 — expansión hispanohablante de menor fricción

- Colombia
- Perú
- Ecuador
- Bolivia

Motivo: idioma compartido, estructuras de propiedad horizontal comparables en términos operativos y buena oportunidad para control de acceso + cobranza. Cada país requiere validación legal/local antes de activar automatizaciones sensibles.

### Ola 2 — mercados con regulación/competencia más exigentes

- Chile
- Argentina
- Uruguay
- Paraguay

Motivo: competencia SaaS más madura en varios de estos mercados y particularidades regulatorias, contables o de datos.

### Carril dedicado — Brasil

Brasil merece tratamiento independiente por tamaño, idioma, pagos y madurez competitiva. Requiere:

- portugués nativo;
- LGPD;
- Pix/boleto e integraciones bancarias locales;
- términos contables/fiscales propios;
- soporte local;
- Country Pack BR dedicado;
- estrategia comercial propia.

No debe ser una simple traducción al portugués.

### Expansión posterior

- Guyana
- Surinam

Requieren idioma, pagos y marco jurídico distintos; no deben bloquear el lanzamiento del núcleo regional.

## Riesgos regulatorios que deben convertirse en diseño

### Cobranza y control de acceso

La regla de VLA que relaciona deuda vencida con habilitación del portón no será una regla regional. Su uso por país/comunidad quedará detrás de una `AccessCollectionPolicy` que deberá estar habilitada únicamente cuando:

1. la legislación local lo permita;
2. el reglamento/contrato de la comunidad lo permita;
3. no afecte derechos esenciales de ingreso/salida;
4. exista procedimiento y auditoría;
5. exista mecanismo fail-safe.

Default regional: **restricción financiera no implica restricción física automáticamente**.

### Datos personales

La plataforma manejará identidad, domicilio, deuda, comprobantes, vehículos y registros de acceso; algunos mercados consideran biometría dato sensible. Se aplicará privacy-by-design:

- minimización;
- cifrado;
- RLS;
- registro de accesos;
- consentimiento/preferencias donde corresponda;
- retención configurable;
- exportación y eliminación conforme a normativa;
- contratos responsable/encargado según país;
- residencia/región de datos evaluable por cliente.

## Requisitos para comercialización con distribuidores

El Control Plane deberá soportar:

- `distributor_id`;
- territorio;
- moneda de venta;
- esquema de comisión;
- cartera de clientes;
- leads;
- instalaciones;
- técnicos autorizados;
- health de dispositivos;
- renovaciones;
- licencias;
- soporte escalado;
- auditoría de acceso del distribuidor a clientes.

Un distribuidor nunca obtiene acceso implícito a los datos financieros de una comunidad solo por haber vendido/instalado hardware.

## Modelo comercial sugerido

Separar claramente:

1. implementación/onboarding;
2. licencia SaaS mensual/anual;
3. módulos premium;
4. hardware MKJOULES;
5. instalación física;
6. soporte/SLA;
7. mensajería transaccional;
8. medios de pago/comisiones;
9. white-label;
10. integraciones especiales.

El precio SaaS debe poder calcularse por bandas de unidades y módulos, no por número de usuarios internos solamente.

## Principio de producto regional

No se aceptará lógica como:

`if (country === 'CL') ...`

esparcida por el código de negocio. Toda variación regional debe resolverse mediante providers, Country Packs, feature flags o políticas versionadas.

## Criterio de salida al mercado

Antes de declarar un país como soportado debe aprobar:

- Country Pack v1;
- revisión legal local;
- moneda/pagos;
- textos y terminología;
- privacidad;
- importador de datos;
- QA financiero;
- QA de zona horaria/fechas;
- QA de mensajes;
- soporte y canal;
- matriz de hardware compatible;
- plan de incidentes y recuperación.

## Decisión

Construir primero una plataforma regional neutral, no una colección de versiones nacionales. Venezuela será el laboratorio inicial, MKJOULES será el socio/preferred provider de acceso, y cada expansión nacional se realizará mediante Country Packs y providers sin alterar el Core.