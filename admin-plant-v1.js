(function () {
  'use strict';

  var endpoint = '/api/vla/admin/plant', plantData = null, loading = false;
  var states = ['ACTIVO', 'SUSPENDIDO_PARCIAL', 'RENUNCIA', 'RESERVA_POR_VENTA', 'REINCORPORACION_PENDIENTE', 'PENDIENTE_NUEVO_PROPIETARIO'];
  var modes = ['PERMITIDA', 'CON_RETROACTIVOS_Y_APROBACION', 'CONDICIONADA_A_CAMBIO_DE_PROPIETARIO_O_ACUERDO', 'NO_PERMITIDA'];
  var categories = ['REPARACION', 'MANTENIMIENTO_PREVENTIVO', 'MANTENIMIENTO_CORRECTIVO', 'REPUESTO', 'MEJORA', 'COMBUSTIBLE_RESIDENCIAL', 'OPERACION_COMUN', 'INSPECCION', 'OTRO'];
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]; }); }
  function money(value) { return '$' + Number(value || 0).toFixed(2); }
  function text(value) { return String(value || '—').replaceAll('_', ' ').toLowerCase(); }
  function notice(message, error) { try { if (typeof toast === 'function') return toast(message, Boolean(error)); } catch (_) {} alert(message); }
  async function api(path, options) { if (typeof adminFetch !== 'function') throw new Error('La sesión administrativa aún no está lista.'); return adminFetch(path, options || {}); }
  function ownerName(ownerId, house) {
    try {
      var mirror = plantData && plantData.houses.find(function (owner) { return owner.ownerId === ownerId; });
      if (mirror && mirror.ownerName) return mirror.ownerName;
      var item = owners.find(function (owner) { return owner.id === ownerId; }); return item ? item.Propietario : 'Casa ' + house;
    } catch (_) { return 'Casa ' + house; }
  }
  function today() { try { return caracasDate(); } catch (_) { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }); } }
  function automaticCounts(summary) {
    summary = summary || {}; var total = Number(summary.totalOwners || 0), statesHtml = Object.keys(summary.byState || {}).sort().map(function (state) { return '<span>' + esc(text(state)) + '<b>' + Number(summary.byState[state] || 0) + '</b></span>'; }).join('');
    var cards = [['Reparaciones', summary.repairs], ['Mantenimiento', summary.maintenance], ['Gasoil residencial', summary.residentialFuel], ['Beneficio común', summary.commonBenefit], ['Servicio activo', summary.residentialServiceActive], ['Acuerdos especiales', summary.specialAgreements]];
    return '<div id="plant-automatic-counts" class="plant-admin-panel plant-auto-summary"><div class="plant-panel-title"><div><h3>Conteo automático de participación</h3><p>El sistema lee el perfil vigente de cada casa. Administración solo verifica y confirma cuando necesita un cambio.</p></div><span class="plant-live-badge">Actualizado ahora</span></div><div class="plant-count-grid">' + cards.map(function (item) { return '<div><span>' + esc(item[0]) + '</span><b>' + Number(item[1] || 0) + '<small>/' + total + '</small></b></div>'; }).join('') + '</div><div class="plant-state-counts">' + statesHtml + '</div></div>';
  }
  function premiumUiExpected() { return Boolean(document.querySelector('meta[name="vla-admin-ui"][content="premium-v1"], #vla-admin-premium-v1')); }
  function ensureUi() {
    if (document.getElementById('plant-management')) return true;
    var premiumNav = document.querySelector('#vla-premium-sidebar .vla-nav');
    var nav = premiumNav || document.querySelector('#app > .container > nav, #app nav');
    if (!nav) return false;
    var button = document.createElement('button');
    if (premiumNav) {
      button.dataset.vlaTarget = 'plant-management';
      button.innerHTML = '<span class="ico">⚡</span>Planta';
      var expensesButton = premiumNav.querySelector('[data-vla-target="expenses"]');
      if (expensesButton) premiumNav.insertBefore(button, expensesButton.nextSibling);
      else premiumNav.appendChild(button);
    } else {
      button.className = 'nav bg-white text-slate-700 px-4 py-2 rounded-full shadow font-semibold';
      button.dataset.target = 'plant-management'; button.innerHTML = '⚡ Planta'; nav.appendChild(button);
    }
    var section = document.createElement('section'); section.id = 'plant-management'; section.className = 'section';
    section.innerHTML = '<div class="vla-admin-plant-shell"><div class="vla-admin-plant-head"><div><p>Motor automático</p><h2>Gestión de la planta eléctrica</h2><span>Perfiles temporales, snapshots inmutables y cero recálculo histórico.</span></div><button id="plant-refresh">Actualizar</button></div><div id="plant-module-body" aria-live="polite"><div class="vla-admin-plant-loading">Abra esta sección para consultar el módulo.</div></div></div>';
    var premiumContent = document.getElementById('vla-premium-content');
    var footer = document.querySelector('#app footer'), container = premiumContent || (footer && footer.parentNode);
    if (container) container.insertBefore(section, footer); else document.querySelector('#app').appendChild(section);
    button.addEventListener('click', function () {
      document.querySelectorAll('.section').forEach(function (item) { item.classList.remove('active'); });
      if (premiumNav) {
        premiumNav.querySelectorAll('[data-vla-target]').forEach(function (item) { item.classList.remove('active'); });
        var title = document.getElementById('vla-current-title'); if (title) title.textContent = 'Planta eléctrica';
        var sidebar = document.getElementById('vla-premium-sidebar'); if (sidebar) sidebar.classList.remove('open');
      } else document.querySelectorAll('.nav').forEach(function (item) { item.classList.remove('active'); });
      button.classList.add('active'); section.classList.add('active'); loadPlant(true);
    });
    document.getElementById('plant-refresh').addEventListener('click', function () { loadPlant(true); });
    document.documentElement.dataset.vlaAdminPlantMenu = premiumNav ? 'premium-sidebar' : 'legacy-nav';
    return true;
  }
  function houseRows(houses) {
    return houses.map(function (item) {
      var profile = item.profile || {}, reinstatement = item.reinstatement || {};
      var accumulated = reinstatement.eligible ? money(reinstatement.total) : profile.specialAgreement ? 'Exento por acuerdo' : 'No aplica';
      return '<tr><td><b>Casa ' + esc(item.house) + '</b><span>' + esc(ownerName(item.ownerId, item.house)) + '</span><span class="plant-email-state ' + (item.hasEmail ? 'is-ready' : 'is-pending') + '">' + (item.hasEmail ? 'Correo listo' : 'Sin correo') + '</span></td><td><b>' + esc(text(profile.state)) + '</b><span>Desde ' + esc(profile.effectiveFrom) + '</span></td><td><span>Rep. ' + (profile.participaReparaciones ? '✓' : '—') + ' · Mant. ' + (profile.participaMantenimiento ? '✓' : '—') + ' · Gasoil ' + (profile.participaGasoilResidencial ? '✓' : '—') + '</span><b>' + (profile.servicioResidencialActivo ? 'Servicio activo' : 'Servicio no activo') + '</b></td><td><b>' + accumulated + '</b><span>Acumulado · ' + esc(text(reinstatement.mode)) + '</span></td><td class="plant-row-actions"><button class="plant-owner-view" data-owner="' + esc(item.ownerId) + '">Ver como propietario</button><button class="plant-profile-simulate" data-owner="' + esc(item.ownerId) + '">Simular</button><button class="plant-profile-edit" data-owner="' + esc(item.ownerId) + '">Control manual</button></td></tr>';
    }).join('');
  }
  function requestRows(requests) {
    if (!requests.length) return '<p class="vla-admin-plant-empty">No hay solicitudes pendientes.</p>';
    return requests.map(function (item) { var canPay = item.type === 'REINCORPORACION' && ['APROBADA_CONDICIONADA', 'PAGO_PENDIENTE'].includes(item.state); return '<article class="plant-request-card"><div><b>Casa ' + esc(item.house) + ' · ' + esc(text(item.type)) + '</b><span>' + esc(item.requestedAt || '') + '</span><p>' + esc(item.reason || '') + '</p></div><div><strong>' + esc(text(item.state)) + '</strong><span>Estimado ' + money(item.estimatedRetroactive) + '</span><button class="plant-request-review" data-request="' + esc(item.requestId) + '">Revisar</button>' + (canPay ? '<button class="plant-request-payment" data-request="' + esc(item.requestId) + '">Vincular pago</button>' : '') + '</div></article>'; }).join('');
  }
  function historyRows(items, accepted) {
    if (accepted) items = items.filter(function (item) { return accepted.includes(item.category); });
    if (!items.length) return '<p class="vla-admin-plant-empty">Sin intervenciones registradas.</p>';
    return items.slice(0, 30).map(function (item) { return '<article class="plant-history-card"><div><b>' + esc(item.description || text(item.category)) + '</b><span>' + esc(item.date || '') + ' · ' + esc(text(item.category)) + '</span></div><div><strong>' + money(item.amountUsd) + '</strong><span>' + (item.historicalOnly ? 'Solo historial' : 'Gasto sellado') + '</span></div></article>'; }).join('');
  }
  function documentRows(items) {
    var rows = [];
    items.forEach(function (item) {
      if (/^https:\/\//i.test(item.publicDocumentUrl || '')) rows.push({ label: item.description || item.interventionId, url: item.publicDocumentUrl, date: item.date });
      (item.documents || []).forEach(function (document) { if (/^https:\/\//i.test(document.url || '')) rows.push({ label: document.name || item.description || 'Documento', url: document.url, date: item.date }); });
    });
    return rows.length ? rows.map(function (item) { return '<a class="plant-document-card" href="' + esc(item.url) + '" target="_blank" rel="noopener"><b>' + esc(item.label) + '</b><span>' + esc(item.date || '') + ' · Abrir documento</span></a>'; }).join('') : '<p class="vla-admin-plant-empty">Aún no hay documentos públicos asociados.</p>';
  }
  function render(data) {
    plantData = data;
    var asset = data.asset || {}, interventions = data.interventions || [], requests = data.requests || [];
    document.getElementById('plant-module-body').innerHTML =
      '<nav class="plant-subnav" aria-label="Secciones de planta">' + [['plant-summary', 'Resumen'], ['plant-interventions', 'Intervenciones'], ['plant-maintenance', 'Mantenimientos'], ['plant-repairs', 'Reparaciones'], ['plant-fuel', 'Combustible'], ['plant-participation', 'Participación por casa'], ['plant-requests-panel', 'Solicitudes de cambio'], ['plant-reinstatements', 'Reincorporaciones'], ['plant-history', 'Historial'], ['plant-documents', 'Documentos']].map(function (item) { return '<a href="#' + item[0] + '">' + item[1] + '</a>'; }).join('') + '</nav>' +
      '<div id="plant-summary" class="plant-kpis"><div><span>Casas configuradas</span><b>' + (data.houses || []).length + '/15</b></div><div><span>Intervenciones</span><b>' + Number(data.interventionCount || 0) + '</b></div><div><span>Solicitudes</span><b>' + requests.length + '</b></div><div><span>Modo</span><b>Histórico seguro</b></div></div>' +
      automaticCounts(data.participationSummary) +
      '<div class="plant-admin-panel"><h3>Resumen · ficha técnica del activo</h3><p>El factor común permanece sin efecto hasta que exista medición y aprobación.</p><form id="plant-asset-form"><div><input name="name" value="' + esc(asset.name || 'Planta eléctrica') + '" placeholder="Nombre"><select name="technicalState">' + ['PENDIENTE_FICHA', 'OPERATIVA', 'MANTENIMIENTO_REQUERIDO', 'FUERA_DE_SERVICIO'].map(function (value) { return '<option value="' + value + '"' + (value === asset.technicalState ? ' selected' : '') + '>' + esc(text(value)) + '</option>'; }).join('') + '</select></div><div><input name="brand" value="' + esc(asset.brand || '') + '" placeholder="Marca"><input name="model" value="' + esc(asset.model || '') + '" placeholder="Modelo"></div><div><input name="serial" value="' + esc(asset.serial || '') + '" placeholder="Serial"><input name="power" value="' + esc(asset.power || '') + '" placeholder="Potencia"></div><div><input name="acquiredAt" type="date" value="' + esc(asset.acquiredAt || '') + '" title="Fecha de adquisición"><input name="installedAt" type="date" value="' + esc(asset.installedAt || '') + '" title="Fecha de instalación"></div><div><input name="hourMeter" type="number" min="0" step="0.1" value="' + esc(asset.hourMeter || 0) + '" placeholder="Horómetro"><input name="nextMaintenanceHours" type="number" min="0" step="0.1" value="' + esc(asset.nextMaintenanceHours || 0) + '" placeholder="Próximo mantenimiento (horas)"></div><div><input name="lastMaintenance" type="date" value="' + esc(asset.lastMaintenance || '') + '" title="Último mantenimiento"><input name="nextMaintenance" type="date" value="' + esc(asset.nextMaintenance || '') + '" title="Próximo mantenimiento"></div><div><input name="commonConsumptionFactor" type="number" min="0" max="1" step="0.0001" value="' + esc(asset.commonConsumptionFactor == null ? '' : asset.commonConsumptionFactor) + '" placeholder="Factor común sin configurar"><label class="plant-factor-check"><input name="commonConsumptionFactorApproved" type="checkbox"' + (asset.commonConsumptionFactorApproved ? ' checked' : '') + '> Medición aprobada</label></div><textarea name="observations" maxlength="3000" placeholder="Observaciones generales">' + esc(asset.observations || '') + '</textarea><button>Actualizar ficha técnica</button></form></div>' +
      '<div id="plant-participation" class="plant-admin-panel"><div class="plant-panel-title"><div><h3>Participación por casa</h3><p>El acumulado suma la cuota pagada por los participantes en cada reparación y mantenimiento. “Ver como propietario” muestra exactamente el mismo desglose.</p></div></div><div class="plant-table-wrap"><table><thead><tr><th>Casa</th><th>Estado</th><th>Reglas</th><th>Acumulado para entrar</th><th>Control</th></tr></thead><tbody>' + houseRows(data.houses || []) + '</tbody></table></div></div>' +
      '<div id="plant-requests-panel" class="plant-admin-panel"><h3>Solicitudes de cambio</h3><div id="plant-requests">' + requestRows(requests) + '</div></div>' +
      '<div id="plant-reinstatements" class="plant-admin-panel"><h3>Reincorporaciones</h3><p>Los 15 simuladores son de solo lectura; el cumplimiento exige un pago definitivo exacto.</p>' + requestRows(requests.filter(function (item) { return item.type === 'REINCORPORACION'; })) + '</div>' +
      '<div id="plant-history" class="plant-admin-panel"><h3>Agregar historial técnico</h3><p>Siempre informativo: no crea gastos ni modifica saldos.</p><form id="plant-history-form"><div><input name="date" type="date" required><select name="category">' + categories.map(function (category) { return '<option value="' + category + '">' + esc(text(category)) + '</option>'; }).join('') + '</select></div><textarea name="description" minlength="5" maxlength="1000" required placeholder="Descripción"></textarea><textarea name="diagnosis" maxlength="2000" placeholder="Diagnóstico"></textarea><textarea name="work" maxlength="2000" placeholder="Trabajo realizado"></textarea><textarea name="spareParts" maxlength="1000" placeholder="Repuestos utilizados"></textarea><div><input name="provider" maxlength="300" placeholder="Proveedor / técnico"><input name="hourMeter" type="number" min="0" step="0.1" placeholder="Horómetro"></div><div><input name="amountUsd" type="number" min="0" step="0.01" placeholder="Monto informativo USD"><input name="amountBs" type="number" min="0" step="0.01" placeholder="Monto informativo Bs"></div><div><input name="bcvRate" type="number" min="0" step="0.0001" placeholder="Tasa BCV"><input name="publicDocumentUrl" type="url" placeholder="Documento público https://"></div><textarea name="documentUrls" maxlength="6000" placeholder="Facturas, fotos o documentos: hasta 6 URLs HTTPS, una por línea"></textarea><textarea name="observations" maxlength="2000" placeholder="Observaciones"></textarea><button>Guardar sin generar cargos</button></form></div>' +
      '<div id="plant-interventions" class="plant-admin-panel"><h3>Intervenciones · expediente técnico y económico</h3><div>' + historyRows(interventions) + '</div></div>' +
      '<div class="plant-admin-grid"><div id="plant-maintenance" class="plant-admin-panel"><h3>Mantenimientos</h3>' + historyRows(interventions, ['MANTENIMIENTO_PREVENTIVO', 'MANTENIMIENTO_CORRECTIVO', 'INSPECCION']) + '</div><div id="plant-repairs" class="plant-admin-panel"><h3>Reparaciones y repuestos</h3>' + historyRows(interventions, ['REPARACION', 'REPUESTO', 'MEJORA']) + '</div></div>' +
      '<div id="plant-fuel" class="plant-admin-panel"><h3>Combustible</h3><p>El gasoil residencial nunca genera retroactivo durante períodos sin servicio.</p>' + historyRows(interventions, ['COMBUSTIBLE_RESIDENCIAL']) + '</div>' +
      '<div id="plant-documents" class="plant-admin-panel"><h3>Documentos</h3><div class="plant-documents">' + documentRows(interventions) + '</div></div>';
    document.querySelectorAll('.plant-owner-view').forEach(function (button) { button.addEventListener('click', function () { openOwnerView(button.dataset.owner); }); });
    document.querySelectorAll('.plant-profile-simulate').forEach(function (button) { button.addEventListener('click', function () { openSimulator(button.dataset.owner); }); });
    document.querySelectorAll('.plant-profile-edit').forEach(function (button) { button.addEventListener('click', function () { openProfile(button.dataset.owner); }); });
    document.querySelectorAll('.plant-request-review').forEach(function (button) { button.addEventListener('click', function () { reviewRequest(button.dataset.request); }); });
    document.querySelectorAll('.plant-request-payment').forEach(function (button) { button.addEventListener('click', function () { confirmPayment(button.dataset.request); }); });
    document.getElementById('plant-asset-form').addEventListener('submit', updateAsset);
    var historyForm = document.getElementById('plant-history-form'); historyForm.date.value = caracasDate(); historyForm.addEventListener('submit', addHistory);
  }
  function openOwnerView(ownerId) {
    var item = plantData && plantData.houses.find(function (row) { return row.ownerId === ownerId; }); if (!item) return;
    var view = item.ownerView || {}, current = view.current || {}, participates = current.participates || {}, reinstatement = view.reinstatement || {}, history = view.history || [], modal = document.createElement('div'); modal.className = 'plant-modal';
    var flags = [['Reparaciones', participates.repairs], ['Mantenimiento', participates.maintenance], ['Gasoil residencial', participates.residentialFuel], ['Beneficio común', participates.commonBenefit], ['Servicio residencial activo', current.residentialServiceActive]];
    var historyHtml = history.length ? history.map(function (row) { var informational = row.status === 'SOLO_INFORMATIVO', corresponding = row.status === 'CORRESPONDIA', accumulating = row.status === 'ACUMULA_REINCORPORACION', result = informational ? 'Informativo' : corresponding ? money(row.amount) : accumulating ? 'Acumula ' + money(row.reinstatementAmount) : 'No correspondía', detail = informational ? 'Sin cargo' : accumulating ? 'Se suma para futura reincorporación' : 'Total intervención: ' + money(row.totalAmount), documentLink = /^https:\/\//i.test(row.publicDocumentUrl || '') ? '<a href="' + esc(row.publicDocumentUrl) + '" target="_blank" rel="noopener">Documento</a>' : ''; return '<div class="plant-owner-history-row"><div><b>' + esc(row.description || text(row.category)) + '</b><span>' + esc(row.date || '') + ' · ' + esc(text(row.category)) + '</span></div><div><strong>' + result + '</strong><span>' + detail + '</span>' + documentLink + '</div></div>'; }).join('') : '<p class="vla-admin-plant-empty">Este propietario todavía no tiene intervenciones visibles.</p>';
    var reinstatementLines = (reinstatement.lines || []).length ? '<details class="plant-mirror-retro"><summary>Ver cálculo de reincorporación (' + reinstatement.lines.length + ')</summary>' + reinstatement.lines.map(function (line) { return '<div><span>' + esc(line.date) + ' · ' + esc(line.concept) + '</span><b>' + money(line.amount) + '</b></div>'; }).join('') + '<p>' + esc(reinstatement.excludedFuelNotice || '') + '</p></details>' : '<p class="plant-mirror-empty-retro">No hay intervenciones recuperables para esta casa.</p>';
    modal.innerHTML = '<div class="plant-modal-card plant-owner-mirror"><button class="plant-modal-x">×</button><div class="plant-mirror-banner"><span>Vista espejo canónica</span><b>Esto es exactamente lo que ve el propietario</b></div><p class="plant-modal-kicker">Casa ' + esc(item.house) + ' · ' + esc(ownerName(item.ownerId, item.house)) + '</p><h3>Información personalizada de planta</h3><p>Generada ' + esc(view.generatedAt || '—') + ' · Contrato ' + esc(plantData.ownerViewContract || 'plant-owner-view-v1') + '</p><div class="plant-owner-current"><div><span>Condición actual</span><b>' + esc(text(current.state)) + '</b><small>Desde ' + esc(current.effectiveFrom || '—') + '</small></div><div><span>Acumulado para reincorporarse</span><b>' + (reinstatement.eligible ? money(reinstatement.total) : current.specialAgreement ? 'Exento por acuerdo' : 'No aplica') + '</b><small>' + Number(reinstatement.interventionCount || 0) + ' reparaciones/mantenimientos</small></div></div><div class="plant-owner-flags">' + flags.map(function (flag) { return '<span class="' + (flag[1] ? 'is-on' : 'is-off') + '">' + (flag[1] ? '✓ ' : '— ') + esc(flag[0]) + '</span>'; }).join('') + '</div>' + reinstatementLines + '<div class="plant-mirror-history"><h4>Historial que recibe esta casa</h4>' + historyHtml + '</div><p class="plant-mirror-note">Esta vista no es una aproximación: Admin y Portal del Propietario consumen el mismo cálculo del servidor.</p></div>';
    document.body.appendChild(modal); modal.querySelector('.plant-modal-x').onclick = function () { modal.remove(); };
    modal.addEventListener('click', function (event) { if (event.target === modal) modal.remove(); });
  }
  function openSimulator(ownerId) {
    var item = plantData && plantData.houses.find(function (row) { return row.ownerId === ownerId; }); if (!item) return;
    var result = item.reinstatement || {}, lines = result.lines || [], modal = document.createElement('div'); modal.className = 'plant-modal';
    var breakdown = lines.length ? lines.map(function (line) { return '<div class="plant-simulation-line"><span>' + esc(line.date) + ' · ' + esc(line.concept) + '</span><span>' + money(line.gross) + (line.recognizedPayment ? ' − ' + money(line.recognizedPayment) : '') + '</span><b>' + money(line.amount) + '</b></div>'; }).join('') : '<p>No hay intervenciones recuperables.</p>';
    modal.innerHTML = '<div class="plant-modal-card plant-simulation"><button class="plant-modal-x">×</button><p class="plant-modal-kicker">Simulación read-only · Casa ' + esc(item.house) + '</p><h3>Reincorporación</h3><p>Salida: ' + esc(result.exitDate || '—') + ' · Simulación: ' + esc(result.at || '—') + ' · Intervenciones: ' + Number(result.interventionCount || 0) + '</p><div class="plant-simulation-categories">' + Object.keys(result.byCategory || {}).map(function (category) { return '<span>' + esc(text(category)) + '<b>' + money(result.byCategory[category]) + '</b></span>'; }).join('') + '</div>' + breakdown + '<div class="plant-simulation-total"><span>Pagos reconocidos: −' + money(result.recognizedPayments) + '</span><strong>Total: ' + money(result.total) + '</strong></div><p>' + esc(result.excludedFuelNotice || '') + '</p><button class="plant-print-simulation" type="button">Imprimir / exportar PDF</button></div>';
    document.body.appendChild(modal); modal.querySelector('.plant-modal-x').onclick = function () { modal.remove(); }; modal.querySelector('.plant-print-simulation').onclick = function () { window.print(); };
    modal.addEventListener('click', function (event) { if (event.target === modal) modal.remove(); });
  }
  async function loadPlant(force) {
    if (loading || (!force && plantData)) return;
    loading = true; var host = document.getElementById('plant-module-body'); host.innerHTML = '<div class="vla-admin-plant-loading">Calculando perfiles e historial…</div>';
    try { render(await api(endpoint)); } catch (error) { host.innerHTML = '<div class="vla-admin-plant-error"><b>Módulo no disponible.</b><br>' + esc(error.message) + '</div>'; }
    finally { loading = false; }
  }
  function openProfile(ownerId) {
    var item = plantData && plantData.houses.find(function (row) { return row.ownerId === ownerId; }); if (!item) return;
    var profile = item.profile || {}, modal = document.createElement('div'); modal.className = 'plant-modal';
    function checked(name) { return profile[name] ? ' checked' : ''; }
    var fulfilled = (plantData.requests || []).filter(function (request) { return request.ownerId === ownerId && request.type === 'REINCORPORACION' && request.state === 'CUMPLIDA' && request.paymentComplete; });
    modal.innerHTML = '<div class="plant-modal-card plant-manual-control"><button class="plant-modal-x">×</button><p class="plant-modal-kicker">Casa ' + esc(item.house) + ' · control administrativo</p><h3>Control manual de condición</h3><p>El sistema precargó las reglas vigentes. Revise y confirme: el cambio puede aplicar desde hoy, crea historial y nunca recalcula gastos anteriores.</p><div class="plant-notification-readiness ' + (item.hasEmail ? 'is-ready' : 'is-pending') + '">' + (item.hasEmail ? '✓ El propietario será notificado automáticamente por correo.' : '⚠ No hay correo configurado; el cambio quedará guardado y el aviso aparecerá como pendiente.') + '</div><form><label>Estado<select name="state">' + states.map(function (state) { return '<option value="' + state + '"' + (state === profile.state ? ' selected' : '') + '>' + esc(text(state)) + '</option>'; }).join('') + '</select></label><div class="plant-flag-grid"><label><input type="checkbox" name="participaReparaciones"' + checked('participaReparaciones') + '> Reparaciones</label><label><input type="checkbox" name="participaMantenimiento"' + checked('participaMantenimiento') + '> Mantenimiento</label><label><input type="checkbox" name="participaGasoilResidencial"' + checked('participaGasoilResidencial') + '> Gasoil residencial</label><label><input type="checkbox" name="participaBeneficioComun"' + checked('participaBeneficioComun') + '> Beneficio común</label><label><input type="checkbox" name="servicioResidencialActivo"' + checked('servicioResidencialActivo') + '> Servicio residencial activo</label><label><input type="checkbox" name="specialAgreement"' + checked('specialAgreement') + '> Acuerdo especial</label></div><div id="plant-projected-counts" class="plant-projected-counts" aria-live="polite"></div><label>Modalidad de reincorporación<select name="reinstatementMode">' + modes.map(function (mode) { return '<option value="' + mode + '"' + (mode === profile.reinstatementMode ? ' selected' : '') + '>' + esc(text(mode)) + '</option>'; }).join('') + '</select></label><label>Solicitud cumplida para activar servicio<select name="reinstatementRequestId"><option value="">No aplica / mantener inactivo</option>' + fulfilled.map(function (request) { return '<option value="' + esc(request.requestId) + '">' + esc(request.requestId) + ' · pago ' + esc(request.definitivePaymentId || '') + '</option>'; }).join('') + '</select></label><label>Fecha de inicio<input name="effectiveFrom" type="date" min="' + today() + '" value="' + today() + '" required></label><label>Motivo verificable<textarea name="reason" minlength="5" maxlength="500" required placeholder="Ej.: condición confirmada por Administración"></textarea></label><label>Observaciones<textarea name="observations" maxlength="1000"></textarea></label><button>Confirmar cambio y notificar</button></form></div>';
    document.body.appendChild(modal); modal.querySelector('.plant-modal-x').onclick = function () { modal.remove(); };
    modal.addEventListener('click', function (event) { if (event.target === modal) modal.remove(); });
    var form = modal.querySelector('form'), summary = plantData.participationSummary || {}, projections = [
      ['participaReparaciones', 'repairs', 'Reparaciones'], ['participaMantenimiento', 'maintenance', 'Mantenimiento'],
      ['participaGasoilResidencial', 'residentialFuel', 'Gasoil'], ['participaBeneficioComun', 'commonBenefit', 'Beneficio común'],
      ['servicioResidencialActivo', 'residentialServiceActive', 'Servicio activo']
    ];
    function updateProjectedCounts() {
      var total = Number(summary.totalOwners || (plantData.houses || []).length), host = modal.querySelector('#plant-projected-counts');
      host.innerHTML = '<span>Así quedará el conteo:</span>' + projections.map(function (entry) { var input = form.elements[entry[0]], projected = Number(summary[entry[1]] || 0) - (profile[entry[0]] ? 1 : 0) + (input.checked ? 1 : 0); return '<b>' + esc(entry[2]) + ' ' + projected + '/' + total + '</b>'; }).join('');
    }
    form.addEventListener('change', updateProjectedCounts); updateProjectedCounts();
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); var button = form.querySelector('button'), f = new FormData(form), profileInput = { state: f.get('state'), reinstatementMode: f.get('reinstatementMode'), participaReparaciones: f.has('participaReparaciones'), participaMantenimiento: f.has('participaMantenimiento'), participaGasoilResidencial: f.has('participaGasoilResidencial'), participaBeneficioComun: f.has('participaBeneficioComun'), servicioResidencialActivo: f.has('servicioResidencialActivo'), specialAgreement: f.has('specialAgreement'), observations: f.get('observations') };
      var confirmationText = 'Casa ' + item.house + ' · ' + ownerName(item.ownerId, item.house) + '\nVigencia: ' + f.get('effectiveFrom') + '\nEstado: ' + text(profileInput.state) + '\nReparaciones: ' + (profileInput.participaReparaciones ? 'Sí' : 'No') + '\nMantenimiento: ' + (profileInput.participaMantenimiento ? 'Sí' : 'No') + '\nGasoil: ' + (profileInput.participaGasoilResidencial ? 'Sí' : 'No') + '\nServicio activo: ' + (profileInput.servicioResidencialActivo ? 'Sí' : 'No') + '\n\nSe creará una versión histórica, no se recalcularán gastos anteriores y ' + (item.hasEmail ? 'se enviará un correo al propietario.' : 'el correo quedará pendiente porque no está configurado.') + '\n\n¿Confirmar este cambio?';
      if (!window.confirm(confirmationText)) return;
      button.disabled = true; button.textContent = 'Confirmando y notificando…';
      try {
        var result = await api(endpoint, { method: 'POST', body: JSON.stringify({ action: 'create-profile-version', confirmation: 'CONFIRMAR_CAMBIO_PLANTA', ownerId: ownerId, effectiveFrom: f.get('effectiveFrom'), reason: f.get('reason'), reinstatementRequestId: f.get('reinstatementRequestId'), profile: profileInput }) });
        notice(result.message); modal.remove(); plantData = null; loadPlant(true);
      } catch (error) { notice(error.message, true); button.disabled = false; button.textContent = 'Confirmar cambio y notificar'; }
    });
  }
  async function reviewRequest(requestId) {
    var request = plantData && plantData.requests.find(function (item) { return item.requestId === requestId; }); if (!request) return;
    var state = prompt('Nuevo estado: EN_REVISION, APROBADA_CONDICIONADA, PAGO_PENDIENTE, RECHAZADA o CANCELADA', request.state === 'RECIBIDA' ? 'EN_REVISION' : request.state); if (!state) return;
    var reason = prompt('Motivo verificable de la revisión:'); if (!reason) return;
    var conditions = prompt('Condiciones administrativas (opcional):', request.conditions || '') || '';
    try { var result = await api(endpoint, { method: 'POST', body: JSON.stringify({ action: 'review-request', requestId: requestId, state: state.toUpperCase(), reason: reason, conditions: conditions, officialRetroactive: request.estimatedRetroactive }) }); notice(result.message); plantData = null; loadPlant(true); } catch (error) { notice(error.message, true); }
  }
  async function confirmPayment(requestId) {
    var paymentId = prompt('ID del pago definitivo ya aprobado en el sistema normal:'); if (!paymentId) return;
    try { var result = await api(endpoint, { method: 'POST', body: JSON.stringify({ action: 'confirm-reinstatement-payment', requestId: requestId, paymentId: paymentId.trim() }) }); notice(result.message); plantData = null; loadPlant(true); } catch (error) { notice(error.message, true); }
  }
  async function updateAsset(event) {
    event.preventDefault(); var form = event.currentTarget, button = form.querySelector('button'), f = new FormData(form); button.disabled = true; button.textContent = 'Actualizando…';
    try { var result = await api(endpoint, { method: 'POST', body: JSON.stringify({ action: 'update-asset-profile', reason: 'Actualización desde panel Planta', asset: { name: f.get('name'), technicalState: f.get('technicalState'), brand: f.get('brand'), model: f.get('model'), serial: f.get('serial'), power: f.get('power'), acquiredAt: f.get('acquiredAt'), installedAt: f.get('installedAt'), hourMeter: Number(f.get('hourMeter') || 0), nextMaintenanceHours: Number(f.get('nextMaintenanceHours') || 0), lastMaintenance: f.get('lastMaintenance'), nextMaintenance: f.get('nextMaintenance'), commonConsumptionFactor: f.get('commonConsumptionFactor'), commonConsumptionFactorApproved: f.has('commonConsumptionFactorApproved'), observations: f.get('observations') } }) }); notice(result.message); plantData = null; loadPlant(true); } catch (error) { notice(error.message, true); } finally { button.disabled = false; button.textContent = 'Actualizar ficha técnica'; }
  }
  async function addHistory(event) {
    event.preventDefault(); var form = event.currentTarget, button = form.querySelector('button'), f = new FormData(form); button.disabled = true; button.textContent = 'Guardando…';
    try { var result = await api(endpoint, { method: 'POST', body: JSON.stringify({ action: 'add-technical-history', date: f.get('date'), category: f.get('category'), description: f.get('description'), diagnosis: f.get('diagnosis'), work: f.get('work'), spareParts: f.get('spareParts'), provider: f.get('provider'), amountUsd: Number(f.get('amountUsd') || 0), amountBs: Number(f.get('amountBs') || 0), bcvRate: Number(f.get('bcvRate') || 0), hourMeter: Number(f.get('hourMeter') || 0), publicDocumentUrl: f.get('publicDocumentUrl'), documentUrls: String(f.get('documentUrls') || '').split(/[\n,]+/).map(function (value) { return value.trim(); }).filter(Boolean), observations: f.get('observations') }) }); notice(result.message); form.reset(); form.date.value = caracasDate(); plantData = null; loadPlant(true); } catch (error) { notice(error.message, true); } finally { button.disabled = false; button.textContent = 'Guardar sin generar cargos'; }
  }
  function looksPlant(concept) { var value = String(concept || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); return ['planta electrica', 'planta', 'generador', 'grupo electrogeno', 'gasoil', 'diesel', 'avr', 'alternador', 'radiador'].some(function (term) { return value.includes(term); }); }
  function enhanceExpenseForm() {
    var form = document.getElementById('expense-form'); if (!form || document.getElementById('expense-domain')) return;
    var concept = document.getElementById('expense-concept'), ownersBox = document.getElementById('owners-checks'), wrapper = document.createElement('div'); wrapper.className = 'plant-expense-intelligence';
    wrapper.innerHTML = '<div class="plant-expense-badge">⚡ Distribución inteligente</div><select id="expense-domain"><option value="AUTO">Detectar automáticamente</option><option value="PLANTA">Gasto de planta</option><option value="GENERAL">Gasto general</option></select><select id="expense-plant-category"><option value="">Categoría automática</option>' + categories.map(function (category) { return '<option value="' + category + '">' + esc(text(category)) + '</option>'; }).join('') + '</select><select id="expense-plant-retroactive"><option value="AUTO">Retroactivo según categoría</option><option value="SI">Genera retroactivo</option><option value="NO">No genera retroactivo</option></select><p id="expense-plant-note">Si el concepto corresponde a la planta, el sistema aplicará los perfiles vigentes y mostrará una confirmación antes de crear el gasto.</p>';
    form.insertBefore(wrapper, document.getElementById('expense-type'));
    var domain = document.getElementById('expense-domain'), category = document.getElementById('expense-plant-category'), retroactive = document.getElementById('expense-plant-retroactive'), expenseType = document.getElementById('expense-type');
    function update() { var active = domain.value === 'PLANTA' || (domain.value === 'AUTO' && looksPlant(concept.value)); category.hidden = !active; retroactive.hidden = !active; ownersBox.classList.toggle('plant-auto-participants', active); if (active) expenseType.value = 'Gasto Especial'; document.getElementById('expense-plant-note').textContent = active ? 'Participantes automáticos según el perfil vigente. Se registra como gasto especial para quedar fuera del pronto pago.' : 'Gasto general: se conserva la selección manual de propietarios.'; }
    domain.addEventListener('change', update); concept.addEventListener('input', update); update();
    form.addEventListener('submit', function (event) {
      var active = domain.value === 'PLANTA' || (domain.value === 'AUTO' && looksPlant(concept.value)); if (!active || domain.value === 'GENERAL') return;
      event.preventDefault(); event.stopImmediatePropagation(); submitPlantExpense(form).catch(function (error) { notice(error.message, true); });
    }, true);
  }
  async function submitPlantExpense(form) {
    if (window.vlaPlantExpenseBusy) return;
    var concept = document.getElementById('expense-concept').value.trim(), amount = Number(document.getElementById('expense-amount').value), type = document.getElementById('expense-type').value, mode = document.getElementById('expense-mode').value, frequency = document.getElementById('expense-frequency').value;
    var monthChoice = (document.getElementById('expense-month') || {}).value || 'current', currentMonth = caracasDate().slice(0, 7), monthDate = new Date(currentMonth + '-01T00:00:00.000Z'); monthDate.setUTCMonth(monthDate.getUTCMonth() + 1); var month = monthChoice === 'next' ? monthDate.toISOString().slice(0, 7) : currentMonth, effectiveDate = month + '-01';
    if (!concept || !(amount > 0)) throw new Error('Complete concepto y monto.');
    window.vlaPlantExpenseBusy = true; var submit = form.querySelector('button[type="submit"],button:not([type])'), original = submit.textContent; submit.disabled = true; submit.textContent = 'Calculando distribución…';
    try {
      var category = document.getElementById('expense-plant-category').value || undefined, retroactiveChoice = document.getElementById('expense-plant-retroactive').value, generatesRetroactive = retroactiveChoice === 'AUTO' ? undefined : retroactiveChoice === 'SI';
      var preview = await api(endpoint, { method: 'POST', body: JSON.stringify({ action: 'preview-expense', concept: concept, amount: amount, type: type, mode: mode, category: category, generatesRetroactive: generatesRetroactive, effectiveDate: effectiveDate }) });
      var included = preview.included.map(function (item) { return 'Casa ' + item.house + ' (' + money(item.amount) + ')'; }).join(', '), excluded = preview.excluded.map(function (item) { return 'Casa ' + item.house; }).join(', ') || 'Ninguna';
      var message = 'Clasificación: ' + text(preview.category) + '\nRegla: ' + text(preview.allocationRule) + '\nGenera retroactivo: ' + (preview.generatesRetroactive ? 'Sí' : 'No') + '\nIncluidas: ' + included + '\nExcluidas: ' + excluded + '\nTotal asignado: ' + money(preview.assignedAmount) + '\n\n¿Confirmar y sellar este snapshot?';
      if (!confirm(message)) return;
      submit.textContent = 'Creando gasto sellado…';
      var allOwners = []; try { allOwners = owners.map(function (owner) { return owner.id; }); } catch (_) { allOwners = Array.from(document.querySelectorAll('#owners-list input')).map(function (input) { return input.value; }); }
      var result = await api('/.netlify/functions/admin-expense', { method: 'POST', body: JSON.stringify({ action: 'create', concept: concept, amount: amount, type: type, mode: mode, frequency: frequency, month: month, ownerIds: allOwners, expenseDomain: 'PLANTA', plantCategory: preview.category, generatesRetroactive: preview.generatesRetroactive, effectiveDate: effectiveDate, confirmPlantSnapshot: true, plantSnapshotHash: preview.snapshotHash }) });
      notice(result.message); form.reset(); document.querySelectorAll('#owners-list input').forEach(function (input) { input.checked = true; }); document.getElementById('expense-domain').value = 'AUTO'; document.getElementById('expense-plant-category').hidden = true; document.getElementById('expense-plant-retroactive').hidden = true; await loadAll(true); plantData = null;
    } finally { window.vlaPlantExpenseBusy = false; submit.disabled = false; submit.textContent = original; }
  }
  function boot() {
    if (premiumUiExpected() && !document.getElementById('vla-premium-sidebar')) {
      document.documentElement.dataset.vlaAdminPlantWaited = 'premium-shell';
      return setTimeout(boot, 80);
    }
    if (!ensureUi()) return setTimeout(boot, 80);
    enhanceExpenseForm(); document.documentElement.dataset.vlaAdminPlant = 'v1';
  }
  (function wait() { if (window.ready === true) boot(); else setTimeout(wait, 60); })();
})();
