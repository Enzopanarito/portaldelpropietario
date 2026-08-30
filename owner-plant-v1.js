(function () {
  'use strict';

  var VERSION = 'owner-plant-v4-2026-08-30-visible-service-status';
  var requestSerial = 0;
  var activeChallenge = '';
  var stateLabels = {
    ACTIVO: 'Servicio residencial activo', SUSPENDIDO_PARCIAL: 'Participación parcial', RENUNCIA: 'Renuncia registrada',
    RESERVA_POR_VENTA: 'Reserva por venta', REINCORPORACION_PENDIENTE: 'Reincorporación pendiente',
    PENDIENTE_NUEVO_PROPIETARIO: 'Pendiente por nuevo propietario'
  };
  var categoryLabels = {
    REPARACION: 'Reparación', MANTENIMIENTO_PREVENTIVO: 'Mantenimiento preventivo',
    MANTENIMIENTO_CORRECTIVO: 'Mantenimiento correctivo', REPUESTO: 'Repuesto', MEJORA: 'Mejora',
    COMBUSTIBLE_RESIDENCIAL: 'Gasoil residencial', OPERACION_COMUN: 'Operación común', INSPECCION: 'Inspección', OTRO: 'Otro'
  };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]; }); }
  function usd(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0)); }
  function label(map, value) { return map[value] || String(value || '—').replaceAll('_', ' ').toLowerCase(); }
  function yes(value) { return value ? '<span class="vla-plant-yes">Sí</span>' : '<span class="vla-plant-no">No</span>'; }
  function ownerId() {
    try { if (typeof currentOwner !== 'undefined' && currentOwner) return currentOwner.id; } catch (_) {}
    var selector = document.getElementById('userSelector');
    return selector && selector.value || '';
  }
  function ensureIndicator() {
    var indicator = document.getElementById('vla-plant-indicator');
    if (indicator) return indicator;
    var gate = document.getElementById('porton-pill');
    if (!gate || !gate.parentNode) return null;
    var group = document.getElementById('vla-owner-service-indicators');
    if (!group) {
      group = document.createElement('div'); group.id = 'vla-owner-service-indicators'; group.className = 'vla-owner-service-indicators self-start';
      gate.parentNode.insertBefore(group, gate); group.appendChild(gate);
    }
    indicator = document.createElement('div'); indicator.id = 'vla-plant-indicator'; indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite');
    group.appendChild(indicator); return indicator;
  }
  function renderIndicator(current) {
    var indicator = ensureIndicator(); if (!indicator) return;
    var status = current && current.serviceStatus || {}, active = status.active === true;
    indicator.innerHTML = '<div class="vla-plant-indicator-pill ' + (active ? 'is-on' : 'is-off') + '"><span class="vla-plant-indicator-icon">⚡</span><span><small>Planta eléctrica</small><strong>' + esc(status.label || (active ? 'Planta activa' : 'Planta inactiva')) + '</strong></span></div>';
    indicator.title = status.detail || '';
  }
  function renderIndicatorLoading(error) {
    var indicator = ensureIndicator(); if (!indicator) return;
    indicator.innerHTML = '<div class="vla-plant-indicator-pill is-pending"><span class="vla-plant-indicator-icon">⚡</span><span><small>Planta eléctrica</small><strong>' + (error ? 'Estado no disponible' : 'Consultando…') + '</strong></span></div>';
  }
  function ensureSection() {
    var section = document.getElementById('vla-owner-plant');
    if (section) return section;
    section = document.createElement('section');
    section.id = 'vla-owner-plant';
    section.className = 'card p-5 sm:p-6 mb-5';
    section.innerHTML = '<div class="vla-plant-heading"><div><p class="vla-plant-kicker">Planta eléctrica</p><h2>Mi modalidad e historial</h2></div><span class="vla-plant-live">Automático</span></div><div id="vla-owner-plant-body" aria-live="polite"><div class="vla-plant-loading">Seleccione su casa para consultar la información personalizada.</div></div>';
    var anchor = document.getElementById('desglose');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(section, anchor.nextSibling);
    return section;
  }
  function renderError(message) {
    renderIndicatorLoading(true);
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML = '<div class="vla-plant-alert"><b>Información temporalmente no disponible.</b><br>' + esc(message) + '</div>';
  }
  function renderVerification(message) {
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML = '<div class="vla-plant-verify"><b>Cambio de condición protegido</b><p>' + esc(message || 'Para solicitar un cambio enviaremos un código al correo registrado del propietario.') + '</p><button id="vla-plant-send-code" type="button">Enviar código para cambiar</button><small>Consultar el estado de la planta no requiere código. La verificación se exige únicamente para cambiar la condición.</small><div id="vla-plant-verify-result" aria-live="polite"></div></div>';
    document.getElementById('vla-plant-send-code').addEventListener('click', requestVerificationCode);
  }
  function renderCodeForm(message) {
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML = '<form id="vla-plant-code-form" class="vla-plant-verify"><b>Revisa tu correo</b><p>' + esc(message || 'Escribe el código de 6 dígitos.') + '</p><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required><button type="submit">Verificar y habilitar cambios</button><button id="vla-plant-resend-code" type="button" class="is-secondary">Enviar otro código</button><div id="vla-plant-verify-result" aria-live="polite"></div></form>';
    document.getElementById('vla-plant-code-form').addEventListener('submit', verifyCode);
    document.getElementById('vla-plant-resend-code').addEventListener('click', requestVerificationCode);
  }
  async function verificationApi(payload) {
    var response = await fetch('/api/vla/payment-reports/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.message || 'No se pudo completar la verificación.');
    return data;
  }
  async function requestVerificationCode() {
    var id = ownerId(), result = document.getElementById('vla-plant-verify-result'), button = document.getElementById('vla-plant-send-code') || document.getElementById('vla-plant-resend-code');
    if (!id || !button) return;
    button.disabled = true; if (result) result.textContent = 'Enviando código…';
    try {
      var data = await verificationApi({ action: 'request', ownerId: id });
      activeChallenge = data.challenge || '';
      renderCodeForm(data.message);
    } catch (error) { if (result) { result.textContent = error.message; result.classList.add('is-error'); } button.disabled = false; }
  }
  async function verifyCode(event) {
    event.preventDefault();
    var form = event.currentTarget, result = form.querySelector('#vla-plant-verify-result'), button = form.querySelector('button[type="submit"]'), code = String(new FormData(form).get('code') || '').trim(), id = ownerId();
    if (!/^\d{6}$/.test(code) || !activeChallenge) { result.textContent = 'Escribe el código de 6 dígitos enviado al correo.'; result.classList.add('is-error'); return; }
    button.disabled = true; result.textContent = 'Verificando…';
    try { await verificationApi({ action: 'verify', ownerId: id, challenge: activeChallenge, code: code }); activeChallenge = ''; await load(id); }
    catch (error) { result.textContent = error.message; result.classList.add('is-error'); button.disabled = false; }
  }
  function render(data) {
    var current = data.current || {}, participation = current.participates || {}, reinstatement = data.reinstatement || {}, history = data.history || [], plans = data.availablePlans || [];
    renderIndicator(current);
    var rows = history.length ? history.map(function (item) {
      var informational = item.status === 'SOLO_INFORMATIVO', corresponding = item.status === 'CORRESPONDIA', accumulating = item.status === 'ACUMULA_REINCORPORACION';
      var documentLink = /^https:\/\//i.test(item.publicDocumentUrl || '') ? '<a class="vla-plant-doc" href="' + esc(item.publicDocumentUrl) + '" target="_blank" rel="noopener">Documento</a>' : '';
      return '<article class="vla-plant-history-row"><div><b>' + esc(item.description || label(categoryLabels, item.category)) + '</b><span>' + esc(item.date) + ' · ' + esc(label(categoryLabels, item.category)) + '</span></div><div class="vla-plant-history-result"><strong>' + (informational ? 'Informativo' : corresponding ? usd(item.amount) : accumulating ? 'Acumula ' + usd(item.reinstatementAmount) : 'No correspondía') + '</strong><span>' + (informational ? 'Sin cargo' : accumulating ? 'Se suma para una futura reincorporación' : 'Total intervención: ' + usd(item.totalAmount)) + '</span>' + documentLink + '</div></article>';
    }).join('') : '<p class="vla-plant-empty">Todavía no hay intervenciones publicadas.</p>';
    var retroLines = (reinstatement.lines || []).length ? '<details class="vla-plant-retro-detail"><summary>Ver cálculo verificable (' + reinstatement.lines.length + ')</summary>' + reinstatement.lines.map(function (line) { return '<div><span>' + esc(line.date) + ' · ' + esc(line.concept) + '</span><b>' + usd(line.amount) + '</b></div>'; }).join('') + '<p>' + esc(reinstatement.excludedFuelNotice || '') + '</p></details>' : '';
    var reinstatementTotal = reinstatement.eligible ? usd(reinstatement.total) : current.specialAgreement ? 'Exento por acuerdo' : 'No aplica';
    var currentPlan = plans.find(function (plan) { return plan.id === current.participationPlan; });
    var selectablePlans = plans.filter(function (plan) { return plan.id !== current.participationPlan; });
    var planOptions = selectablePlans.map(function (plan) { return '<option value="' + esc(plan.id) + '">' + esc(plan.label) + '</option>'; }).join('');
    var changeForm = current.specialAgreement
      ? '<div class="vla-plant-alert"><b>Condición especial protegida.</b><br>Esta casa debe gestionar cualquier cambio directamente con Administración.</div>'
      : data.changeAuthorizationRequired
        ? '<div class="vla-plant-change-lock"><b>Cambio de condición protegido</b><p>El estado, la modalidad y el historial pueden consultarse sin código. Para solicitar un cambio debes verificar el correo registrado.</p><button id="vla-plant-send-code" type="button">Verificar para cambiar condición</button><div id="vla-plant-verify-result" aria-live="polite"></div></div>'
      : '<form id="vla-plant-request-form" class="vla-plant-request"><h3>Cambiar modalidad de planta</h3><p>Elige exactamente cuáles gastos mantendrás. Toda opción distinta del servicio completo suspende el servicio residencial.</p><label>Modalidad solicitada<select name="requestedPlan" required>' + planOptions + '</select></label><div id="vla-plant-plan-preview" class="vla-plant-alert"></div><div class="vla-plant-request-grid"><input name="proposedEffectiveDate" type="date" required></div><textarea name="reason" minlength="10" maxlength="1000" required placeholder="Explique el motivo del cambio"></textarea><input name="website" tabindex="-1" autocomplete="off" class="vla-plant-honeypot"><button type="submit">Enviar modalidad para confirmación</button><div class="vla-plant-request-result" aria-live="polite"></div></form>';
    var accumulatedExplanation = current.participationPlan === 'SUSPENDE_SOLO_GASOIL'
      ? 'Mantienes mantenimiento y reparaciones, por eso esta modalidad no genera deuda para volver. El gasoil no se acumula.'
      : 'Suma únicamente los mantenimientos o reparaciones que dejaste de pagar. El gasoil nunca se acumula.';
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML =
      '<div class="vla-plant-status"><div><span>Casa ' + esc(data.house) + '</span><strong>' + esc(currentPlan ? currentPlan.label : label(stateLabels, current.state)) + '</strong><small>Vigente desde ' + esc(current.effectiveFrom) + '</small></div><div class="vla-plant-service ' + (current.residentialServiceActive ? 'is-on' : 'is-off') + '">' + (current.residentialServiceActive ? 'Servicio activo' : 'Servicio suspendido') + '</div></div>' +
      '<div class="vla-plant-rules"><div><span>Reparaciones</span>' + yes(participation.repairs) + '</div><div><span>Mantenimiento</span>' + yes(participation.maintenance) + '</div><div><span>Gasoil residencial</span>' + yes(participation.residentialFuel) + '</div><div><span>Beneficio común</span>' + yes(participation.commonBenefit) + '</div></div>' +
      '<div class="vla-plant-retro"><div><span>Acumulado para reincorporarse</span><strong>' + reinstatementTotal + '</strong><small>' + esc(accumulatedExplanation) + '</small></div>' + retroLines + '</div>' +
      '<div class="vla-plant-history"><h3>Historial técnico y económico</h3>' + rows + '</div>' +
      changeForm;
    var unlock = document.getElementById('vla-plant-send-code');
    if (unlock) unlock.addEventListener('click', requestVerificationCode);
    var form = document.getElementById('vla-plant-request-form');
    if (!form) return;
    form.proposedEffectiveDate.min = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    form.proposedEffectiveDate.value = form.proposedEffectiveDate.min;
    function updatePlanPreview() {
      var selected = plans.find(function (plan) { return plan.id === form.requestedPlan.value; });
      var preview = document.getElementById('vla-plant-plan-preview'); if (!selected || !preview) return;
      preview.innerHTML = '<b>' + esc(selected.serviceActive ? 'Servicio activo' : 'Servicio suspendido') + '</b><br>' + esc(selected.description) + (selected.accrues.length ? '<br><strong>Se acumulará: ' + esc(selected.accrues.join(' y ').toLowerCase()) + '.</strong>' : '<br><strong>No genera acumulado nuevo para reincorporarse.</strong>');
    }
    form.requestedPlan.addEventListener('change', updatePlanPreview); updatePlanPreview();
    form.addEventListener('submit', submitRequest);
  }
  async function submitRequest(event) {
    event.preventDefault();
    var form = event.currentTarget, result = form.querySelector('.vla-plant-request-result'), button = form.querySelector('button'), id = ownerId();
    if (!id) return;
    var fields = new FormData(form), plan = form.requestedPlan.options[form.requestedPlan.selectedIndex];
    if (!confirm('¿Solicitar la modalidad “' + String(plan && plan.textContent || '') + '”? Administración confirmará la fecha efectiva y el sistema aplicará automáticamente los gastos correspondientes.')) return;
    button.disabled = true; button.textContent = 'Enviando…'; result.textContent = '';
    try {
      var response = await fetch('/api/vla/plant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerId: id, requestedPlan: fields.get('requestedPlan'), proposedEffectiveDate: fields.get('proposedEffectiveDate'), reason: fields.get('reason'), website: fields.get('website'), confirmation: 'SOLICITAR_CAMBIO_PLANTA' }) });
      var data = await response.json().catch(function () { return {}; });
      if (response.status === 401 && data.verificationRequired) { renderVerification(data.message); return; }
      if (!response.ok) throw new Error(data.message || 'No se pudo enviar la solicitud.');
      result.innerHTML = '<b>Solicitud ' + esc(data.requestId || '') + '</b><br>' + esc(data.message || 'Recibida.');
      form.reason.value = '';
    } catch (error) { result.textContent = error.message; result.classList.add('is-error'); }
    finally { button.disabled = false; button.textContent = 'Enviar modalidad para confirmación'; }
  }
  async function load(id) {
    ensureSection();
    if (!id) return;
    var serial = ++requestSerial, host = document.getElementById('vla-owner-plant-body');
    renderIndicatorLoading(false);
    host.innerHTML = '<div class="vla-plant-loading">Consultando modalidad e historial…</div>';
    try {
      var response = await fetch('/api/vla/plant?ownerId=' + encodeURIComponent(id), { cache: 'no-store' });
      var data = await response.json().catch(function () { return {}; });
      if (serial !== requestSerial) return;
      if (response.status === 401 && data.verificationRequired) { renderVerification(data.message); return; }
      if (!response.ok) throw new Error(data.message || 'No se pudo consultar el módulo.');
      render(data);
    } catch (error) { if (serial === requestSerial) renderError(error.message); }
  }
  function boot() {
    ensureSection(); ensureIndicator();
    var original = window.renderUser;
    if (typeof original === 'function' && !original.__vlaPlantWrapped) {
      var wrapped = function (id) { var result = original.apply(this, arguments); setTimeout(function () { load(id); }, 0); return result; };
      wrapped.__vlaPlantWrapped = true; window.renderUser = wrapped;
    }
    var selector = document.getElementById('userSelector');
    if (selector) selector.addEventListener('change', function () { load(selector.value); });
    var id = ownerId(); if (id) load(id);
    document.documentElement.dataset.vlaOwnerPlant = VERSION;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
