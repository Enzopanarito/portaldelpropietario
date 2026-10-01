[Reading 102 lines from start (total: 102 lines, 0 remaining)]

'use strict';

const TIME_ZONE = 'America/Caracas';
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 21; // 21:00 ya está fuera de la ventana.

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function cycleId(year, month, day, hour, minute) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

function monthCycles(year, month) {
  const lastDay = daysInMonth(year, month);
  const cycles = [];
  const add = (day, hour, minute = 0, kind = 'regular') => {
    if (day < 1 || day > lastDay) return;
    cycles.push({
      id: cycleId(year, month, day, hour, minute),
      year, month, day, hour, minute, kind,
      isMonthEnd: day === lastDay
    });
  };

  add(1, 9, 0, 'month_start');
  for (const day of [3, 6, 9, 11]) add(day, 9, 0, 'regular');
  for (let day = 13; day <= lastDay - 5; day += 2) add(day, 9, 0, 'regular');
  for (let day = Math.max(1, lastDay - 4); day <= lastDay; day += 1) {
    add(day, 9, 0, day === lastDay ? 'month_end' : 'regular');
  }

  cycles.sort((a,b) => a.day - b.day || a.hour - b.hour || a.minute - b.minute);
  for (const c of cycles) if (c.day === lastDay) { c.kind = 'month_end'; c.isMonthEnd = true; }
  return cycles;
}

function minutesOfDay(parts) {
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function inAllowedWindow(parts) {
  const minutes = minutesOfDay(parts);
  return minutes >= WINDOW_START_HOUR * 60 && minutes < WINDOW_END_HOUR * 60;
}

function compareCycleToParts(cycle, parts) {
  const day = Number(parts.day);
  if (cycle.day !== day) return cycle.day - day;
  const cMin = cycle.hour * 60 + cycle.minute;
  return cMin - minutesOfDay(parts);
}

function activeCycle(date = new Date()) {
  const p = zonedParts(date);
  const year = Number(p.year), month = Number(p.month);
  const cycles = monthCycles(year, month);
  let latest = null;
  let next = null;
  for (const cycle of cycles) {
    const cmp = compareCycleToParts(cycle, p);
    if (cmp <= 0) latest = cycle;
    else { next = cycle; break; }
  }

  // Nunca arrastramos el último lote del mes anterior al nuevo mes.
  if (!latest) return { parts: p, allowed: inAllowedWindow(p), cycle: null, next: cycles[0] || null };
  return { parts: p, allowed: inAllowedWindow(p), cycle: latest, next };
}

function scheduleSummary(year, month) {
  return monthCycles(year, month).map(c => ({
    id: c.id,
    day: c.day,
    time: `${String(c.hour).padStart(2,'0')}:${String(c.minute).padStart(2,'0')}`,
    kind: c.kind,
    isMonthEnd: c.isMonthEnd
  }));
}

module.exports = {
  TIME_ZONE,
  WINDOW_START_HOUR,
  WINDOW_END_HOUR,
  zonedParts,
  daysInMonth,
  monthCycles,
  activeCycle,
  inAllowedWindow,
  scheduleSummary
};

[executed on device: Mac-mini-de-Enzo (909fb371-3e1b-4735-8ad5-672c084a9358)]