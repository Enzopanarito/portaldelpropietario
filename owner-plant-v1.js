(function () {
  'use strict';

  var VERSION = 'owner-plant-v2-2026-08-21';
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
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML = '<div class="vla-plant-alert"><b>Información temporalmente no disponible.</b><br>' + esc(message) + '</div>';
  }
  function renderVerification(message) {
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML = '<div class="vla-plant-verify"><b>Verifica esta casa</b><p>' + esc(message || 'Para proteger el historial, enviaremos un código al correo registrado del propietario.') + '</p><button id="vla-plant-send-code" type="button">Enviar código</button><small>La misma verificación protege “Mis reportes” y dura 30 días en este dispositivo.</small><div id="vla-plant-verify-result" aria-live="polite"></div></div>';
    document.getElementById('vla-plant-send-code').addEventListener('click', requestVerificationCode);
  }
  function renderCodeForm(message) {
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML = '<form id="vla-plant-code-form" class="vla-plant-verify"><b>Revisa tu correo</b><p>' + esc(message || 'Escribe el código de 6 dígitos.') + '</p><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required><button type="submit">Verificar y mostrar historial</button><button id="vla-plant-resend-code" type="button" class="is-secondary">Enviar otro código</button><div id="vla-plant-verify-result" aria-live="polite"></div></form>';
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
    var current = data.current || {}, participation = current.participates || {}, reinstatement = data.reinstatement || {}, history = data.history || [];
    var rows = history.length ? history.map(function (item) {
      var informational = item.status === 'SOLO_INFORMATIVO', corresponding = item.status === 'CORRESPONDIA', accumulating = item.status === 'ACUMULA_REINCORPORACION';
      var documentLink = /^https:\/\//i.test(item.publicDocumentUrl || '') ? '<a class="vla-plant-doc" href="' + esc(item.publicDocumentUrl) + '" target="_blank" rel="noopener">Documento</a>' : '';
      return '<article class="vla-plant-history-row"><div><b>' + esc(item.description || label(categoryLabels, item.category)) + '</b><span>' + esc(item.date) + ' · ' + esc(label(categoryLabels, item.category)) + '</span></div><div class="vla-plant-history-result"><strong>' + (informational ? 'Informativo' : corresponding ? usd(item.amount) : accumulating ? 'Acumula ' + usd(item.reinstatementAmount) : 'No correspondía') + '</strong><span>' + (informational ? 'Sin cargo' : accumulating ? 'Se suma para una futura reincorporación' : 'Total intervención: ' + usd(item.totalAmount)) + '</span>' + documentLink + '</div></article>';
    }).join('') : '<p class="vla-plant-empty">Todavía no hay intervenciones publicadas.</p>';
    var retroLines = (reinstatement.lines || []).length ? '<details class="vla-plant-retro-detail"><summary>Ver cálculo verificable (' + reinstatement.lines.length + ')</summary>' + reinstatement.lines.map(function (line) { return '<div><span>' + esc(line.date) + ' · ' + esc(line.concept) + '</span><b>' + usd(line.amount) + '</b></div>'; }).join('') + '<p>' + esc(reinstatement.excludedFuelNotice || '') + '</p></details>' : '';
    var reinstatementTotal = reinstatement.eligible ? usd(reinstatement.total) : current.specialAgreement ? 'Exento por acuerdo' : 'No aplica';
    ensureSection().querySelector('#vla-owner-plant-body').innerHTML =
      '<div class="vla-plant-status"><div><span>Casa ' + esc(data.house) + '</span><strong>' + esc(label(stateLabels, current.state)) + '</strong><small>Vigente desde ' + esc(current.effectiveFrom) + '</small></div><div class="vla-plant-service ' + (current.residentialServiceActive ? 'is-on' : 'is-off') + '">' + (current.residentialServiceActive ? 'Servicio activo' : 'Servicio no activo') + '</div></div>' +
      '<div class="vla-plant-rules"><div><span>Reparaciones</span>' + yes(participation.repairs) + '</div><div><span>Mantenimiento</span>' + yes(participation.maintenance) + '</div><div><span>Gasoil residencial</span>' + yes(participation.residentialFuel) + '</div><div><span>Beneficio común</span>' + yes(participation.commonBenefit) + '</div></div>' +
      '<div class="vla-plant-retro"><div><span>Acumulado para reincorporarse</span><strong>' + reinstatementTotal + '</strong><small>Suma su cuota de cada reparación y mantenimiento ocurrido mientras no participaba. El gasoil no se incluye.</small></div>' + retroLines + '</div>' +
      '<div class="vla-plant-history"><h3>Historial técnico y económico</h3>' + rows + '</div>' +
      '<form id="vla-plant-request-form" class="vla-plant-request"><h3>Solicitar cambio de modalidad</h3><p>Enviar esta solicitud no cambia cargos ni activa el servicio automáticamente.</p><div class="vla-plant-request-grid"><select name="type" required><option value="REINCORPORACION">Solicitar reincorporación</option><option value="SUSPENSION">Solicitar suspensión</option><option value="CAMBIO_MODALIDAD">Cambiar modalidad</option><option value="RENUNCIA">Registrar renuncia</option><option value="CAMBIO_PROPIETARIO">Cambio de propietario</option></select><input name="proposedEffectiveDate" type="date" required></div><textarea name="reason" minlength="10" maxlength="1000" required placeholder="Explique el motivo"></textarea><input name="website" tabindex="-1" autocomplete="off" class="vla-plant-honeypot"><button type="submit">Enviar para revisión</button><div class="vla-plant-request-result" aria-live="polite"></div></form>';
    var form = document.getElementById('vla-plant-request-form');
    form.proposedEffectiveDate.min = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    form.proposedEffectiveDate.value = form.proposedEffectiveDate.min;
    form.type.value = current.residentialServiceActive ? 'SUSPENSION' : 'REINCORPORACION';
    form.addEventListener('submit', submitRequest);
  }
  async function submitRequest(event) {
    event.preventDefault();
    var form = event.currentTarget, result = form.querySelector('.vla-plant-request-result'), button = form.querySelector('button'), id = ownerId();
    if (!id) return;
    if (!confirm('¿Enviar esta solicitud a administración? No tendrá efecto financiero directo.')) return;
    button.disabled = true; button.textContent = 'Enviando…'; result.textContent = '';
    try {
      var fields = new FormData(form), response = await fetch('/api/vla/plant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerId: id, type: fields.get('type'), proposedEffectiveDate: fields.get('proposedEffectiveDate'), reason: fields.get('reason'), website: fields.get('website'), confirmation: 'SOLICITAR_CAMBIO_PLANTA' }) });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.message || 'No se pudo enviar la solicitud.');
      result.innerHTML = '<b>Solicitud ' + esc(data.requestId || '') + '</b><br>' + esc(data.message || 'Recibida.');
      form.reason.value = '';
    } catch (error) { result.textContent = error.message; result.classList.add('is-error'); }
    finally { button.disabled = false; button.textContent = 'Enviar para revisión'; }
  }
  async function load(id) {
    ensureSection();
    if (!id) return;
    var serial = ++requestSerial, host = document.getElementById('vla-owner-plant-body');
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
    ensureSection();
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
