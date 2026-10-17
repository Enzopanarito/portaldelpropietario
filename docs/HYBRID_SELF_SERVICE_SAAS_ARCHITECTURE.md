# Plataforma regional: SaaS híbrido y autoconfigurable

## Decisión aprobada

Una plataforma central en Vercel con registro institucional y portal propio por condominio. Los clientes pequeños y medianos comparten infraestructura Supabase con aislamiento estricto de datos. Los grandes pueden usar proyectos exclusivos.

El mismo núcleo comercial soporta ambas modalidades. El cliente configura identidad, logotipo, correo, estructuras, apartamentos, módulos contratados, pagos, comunicaciones y proveedores sin recibir ni modificar código.

## Capas

- **Vercel**: una aplicación regional Next.js y muchos portales por dominio/subdominio. No crear un proyecto Vercel por condominio.
- **Control Plane de la sociedad**: registro comercial, dominio verificado, país, planes, versiones, distribuidores MKJ y asignaciones de pool. Sin registros financieros ni documentos de propietarios.
- **Data Plane**: comunidad, unidades, personas, pagos, saldos derivados del ledger, recibos, acceso y auditoría. Cada fila sensible tiene tenant y RLS según pertenencia real.
- **Pool compartido**: varios tenants de un mismo país, según jurisdicción y capacidad, dentro de un solo Supabase; aislados mediante membresía, Auth y RLS.
- **Pool dedicado**: un tenant por proyecto, con propiedad y migraciones según contrato. Transferencia del proyecto al cliente cuando corresponda.

## Seguridad

- Un dominio verificado y tenant activo resuelve su vínculo a un pool activo/saludable. El Control Plane comprueba país y modo antes de responder.
- Al navegador solo viajan URL y publishable key, identidad pública y funcionalidades seguras. Nunca service keys, contraseñas, balances o tokens OAuth.
- Las políticas RLS se basan en Auth y membresías del Data Plane. Nunca usar user_metadata como fuente de roles.
- Control Plane restringido a backend con credenciales protegidas; secretos de clientes cifrados.
- Controlar cuota/consumo por tenant, backups y restauración, operaciones privilegiadas con auditoría e idempotencia, y migración entre pools.
- El registro de alguien por web no acredita su representación legal ni autoriza un portón. Verificación de administrador e integraciones físicas es obligatoria.
- Restricciones por deuda físicas deshabilitadas por defecto y sujetas a Country Pack y revisión legal; MKJ preferente pero no exclusivo.

## Experiencia de alta (pendiente de UI/API completas)

1. Crear cuenta institucional y verificar correo y representación.
2. Elegir país, plan, nombre, logo, correo y dominio.
3. Elegir o asignar el pool compartido compatible o uno dedicado si corresponde.
4. Crear tenant con el mismo UUID en Control Plane y Data Plane, antes de añadir unidades.
5. Importar/crear torres, apartamentos, propietarios y alícuotas.
6. Configurar módulos, cuotas, monedas, pagos y notificaciones conforme al Country Pack.
7. Conciliar apertura por moneda y hacer pruebas de seguridad, permisos y accesos en simulación.
8. Activar portal con dominio verificado. El cliente seguirá autoconfigurándolo desde el panel.

## Compatibilidad y estado de implementación

La migración aditiva ordenada crea data_plane_pools y tenant_pool_bindings en el Control Plane. Conserva la tabla antigua data_planes para despliegues dedicados preexistentes. El registro por dominio utiliza el binding nuevo primero y el antiguo como fallback transitorio. Se preserva el Data Plane actual.

Probado en el Supabase gratuito de laboratorio con dos tenants venezolanos compartiendo un pool, una asignación dedicada y rechazos para país o modo incompatible. Las pruebas se realizaron dentro de una transacción revertida. El auditor de seguridad reportó cero hallazgos.

Aún NO se ha creado el registro público de autoservicio, ni configurado pagos comerciales, ni desplegado la aplicación comercial en Vercel. Tampoco se ha migrado VLA producción.

## Propiedad intelectual

El repositorio de origen es público: antes de ampliar significativamente la implementación propietaria hay que migrar el SaaS comercial a un repositorio privado de la futura sociedad. No incorporar secretos, datos privados ni firmware de MKJ en el repositorio público.

Nota operativa: el esquema privado del Control Plane todavía no está expuesto al Data API en el laboratorio. El adaptador Vercel requiere un acceso backend autorizado a esa base antes de poder servir tenants reales.
