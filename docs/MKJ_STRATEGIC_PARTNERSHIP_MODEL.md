# Modelo estratégico de alianza con MKJOULES

## Contexto

La empresa identificada públicamente es MKJOULES USA CORP, proveedor de soluciones de control de acceso, controles remotos, receptores, tableros para motores, portones, cercos eléctricos y equipos conectados. La plataforma comercial de gestión condominial puede combinar su capa física de acceso con el software financiero/operativo derivado del sistema VLA.

## Principio central

La alianza debe crear una ventaja conjunta sin mezclar indebidamente la propiedad intelectual preexistente de las partes.

### Aporte software

La plataforma aporta, entre otros:

- motor financiero;
- cobranza;
- pagos y comprobantes;
- portal del residente;
- administración;
- comunicaciones;
- automatizaciones;
- IA/asistente;
- auditoría;
- configuración regional;
- integraciones;
- orquestación con control de acceso.

### Aporte MKJOULES

MKJOULES puede aportar, sujeto al acuerdo final:

- hardware y firmware;
- receptores/controladores;
- APIs/cloud de acceso;
- conocimiento de instalación;
- canal de distribuidores;
- soporte de campo;
- compatibilidad técnica;
- inventario/logística;
- marca y posicionamiento en seguridad/acceso.

## Estructura de propiedad intelectual recomendada

### Background IP

Todo activo que existía antes de la sociedad permanece siendo propiedad de quien lo aportó originalmente, salvo acuerdo expreso y valorado.

Ejemplos:

- código VLA / motor financiero previo: Background IP del titular de software;
- hardware/firmware MKJOULES, marcas y tecnología previa: Background IP de MKJOULES.

La sociedad recibe licencias suficientes para comercializar la solución conjunta dentro del alcance contractual.

### Foreground IP

Los desarrollos nuevos hechos específicamente por/para la nueva sociedad deben tener reglas explícitas de propiedad:

- core regional;
- Country Packs;
- conectores;
- dashboards de distribuidores;
- onboarding;
- automatización de provisioning;
- nuevas APIs conjuntas.

No asumir propiedad conjunta automática. Debe definirse por contrato, módulo por módulo o por categorías.

## Recomendación de estructura comercial

Separar tres capas económicas:

1. **Software SaaS**
   - setup;
   - licencia por unidades/módulos;
   - soporte;
   - white-label;
   - IA/mensajería;
   - integraciones.

2. **Hardware / instalación**
   - equipos MKJOULES;
   - instalación;
   - mantenimiento físico;
   - reemplazos/garantías.

3. **Canal/distribución**
   - comisión o margen del distribuidor;
   - territorio;
   - metas;
   - soporte nivel 1/2/3;
   - renovación.

Esto permite medir correctamente qué genera valor y evita subsidiar hardware con SaaS o viceversa.

## Integración técnica

MKJOULES será `preferred AccessProvider`, no dependencia estructural del Core.

Debe existir un contrato interno de integración con:

- identificación estable de organización/dispositivo/usuario;
- alta/baja;
- enable/disable;
- consulta de estado;
- eventos;
- reconciliación;
- apertura remota autorizada;
- idempotencia;
- retries;
- rate limits;
- webhooks cuando sea posible;
- health endpoint;
- ambientes de prueba;
- versionado;
- deprecation policy.

## Requisitos contractuales críticos de API

Antes de una expansión regional deben acordarse por escrito:

- disponibilidad de API;
- documentación;
- autenticación;
- límites;
- propiedad de datos;
- retención de logs;
- cambios incompatibles;
- preaviso de versiones;
- SLA;
- seguridad;
- incidentes;
- soporte;
- derecho de uso en todos los países objetivo;
- continuidad de integración si cambia la relación societaria.

## Evitar lock-in dañino

Aunque MKJOULES sea socio, el SaaS debe soportar otros proveedores de acceso.

Motivos:

- condominios ya instalados con otra marca;
- adquisiciones de clientes grandes;
- países donde MKJOULES todavía no tenga canal;
- requisitos corporativos;
- continuidad del producto;
- competencia e interoperabilidad.

La ventaja para MKJOULES debe provenir de ser la mejor integración, mejor bundle y mejor canal, no de impedir técnicamente alternativas.

## Oportunidad comercial conjunta

Bundle sugerido:

**Smart Condominium by [marca JV] + MKJOULES Access**

Incluye según plan:

- administración financiera;
- portal/app/PWA;
- cobranza automatizada;
- reporte/validación de pagos;
- comunicaciones;
- acceso vehicular/peatonal;
- visitas;
- credenciales;
- bitácora;
- IA de residentes;
- mantenimiento;
- dashboard de administración;
- dashboard del distribuidor.

El argumento comercial no debe ser solamente reducción de trabajo administrativo. Debe vender:

- mejor cobranza;
- seguridad;
- trazabilidad;
- menor fricción de acceso;
- menos procesos manuales;
- integración de hardware y administración;
- transparencia para propietarios;
- control para administradoras.

## Canal MKJOULES

La red de instaladores/distribuidores puede convertirse en canal de adquisición del SaaS.

Flujo objetivo:

1. distribuidor vende/actualiza control de acceso;
2. ofrece plataforma condominial;
3. registra lead en Control Plane;
4. onboarding crea comunidad;
5. se importa padrón/saldos;
6. se vincula hardware;
7. se capacita administrador;
8. se activa producción;
9. distribuidor mantiene hardware;
10. JV mantiene SaaS e integraciones.

## Roles de soporte

### Nivel 1
Distribuidor/partner local:
- instalación;
- conectividad;
- controles/lectores;
- preguntas básicas.

### Nivel 2
Operación SaaS:
- configuración;
- usuarios;
- pagos;
- reglas;
- importaciones;
- comunicaciones.

### Nivel 3
Ingeniería:
- bugs;
- incidentes;
- integraciones;
- bases de datos;
- seguridad;
- reconciliaciones críticas.

## Datos y privacidad

El distribuidor o técnico MKJOULES no obtiene automáticamente acceso a:

- saldos;
- comprobantes;
- estados de cuenta;
- datos sensibles;
- documentos privados.

Debe aplicarse mínimo privilegio. El acceso técnico al hardware será un permiso distinto del acceso financiero.

## Protección ante ruptura societaria

La sociedad debe acordar desde el inicio:

- quién puede seguir atendiendo clientes existentes;
- continuidad de API;
- licencias de Background IP;
- uso de marcas;
- datos de clientes;
- dominios;
- repositorios;
- credenciales;
- derechos de soporte;
- transición ordenada;
- no interrupción de comunidades por conflicto societario.

Ningún condominio debe quedar sin poder abrir su portón o consultar sus pagos por un conflicto entre socios.

## Exclusividad

No recomendar exclusividad absoluta y perpetua.

Si existe exclusividad, debe estar limitada por:

- territorio;
- línea de producto;
- plazo;
- objetivos mínimos;
- SLA;
- disponibilidad de hardware;
- compatibilidad;
- causal de salida.

## Decisión técnica

MKJOULES se considera socio estratégico y proveedor preferente de control de acceso para la plataforma regional. El Core seguirá siendo provider-agnostic. La integración MKJ será la primera y más profunda, pero deberá respetar interfaces estándar para permitir expansión regional, coexistencia con instalaciones existentes y continuidad empresarial.