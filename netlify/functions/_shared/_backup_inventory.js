'use strict';

// Inventario canónico de tablas operativas VLA que deben formar parte del
// respaldo integral. Mantener una única fuente evita que Health y el exportador
// declaren coberturas distintas cuando el esquema de Airtable evoluciona.
const TABLES = Object.freeze([
  'Propietarios',
  'Gastos del Mes',
  'Configuración',
  'Pagos',
  'Historial de Cargos',
  'Reportes de Pago',
  'Recibos de Pago',
  'Cierres de Auditoría',
  'ControlVersiones',
  'WhatsApp Jobs',
  'WhatsApp Programaciones',
  'Cuentas de Cobro Autorizadas'
]);

module.exports = { TABLES };
