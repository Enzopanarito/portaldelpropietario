'use strict';

const TIME_ZONE = 'America/Caracas';
const RECOVERY_DAYS = Object.freeze([1, 2, 3]);

function isValidMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '').trim());
}

function caracasClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    day: Number(parts.day || 0),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0)
  };
}

function previousMonth(month) {
  if (!isValidMonth(month)) return '';
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function defaultDryRunMonth(now = new Date()) {
  const clock = caracasClock(now);
  return RECOVERY_DAYS.includes(clock.day) ? previousMonth(clock.month) : clock.month;
}

function closeWindowForMonth(month, now = new Date()) {
  const clock = caracasClock(now);
  const expectedMonth = previousMonth(clock.month);
  const dayAllowed = RECOVERY_DAYS.includes(clock.day);
  const monthAllowed = isValidMonth(month) && month === expectedMonth;
  return {
    ok: dayAllowed && monthAllowed,
    clock,
    expectedMonth,
    requestedMonth: String(month || ''),
    dayAllowed,
    monthAllowed,
    recoveryDay: dayAllowed ? clock.day : null,
    message: dayAllowed && monthAllowed
      ? `Ventana de cierre válida para ${month}.`
      : `El cierre real solo puede ejecutar el mes anterior durante los días 1, 2 o 3 en ${TIME_ZONE}.`
  };
}

module.exports = {
  TIME_ZONE,
  RECOVERY_DAYS,
  isValidMonth,
  caracasClock,
  previousMonth,
  defaultDryRunMonth,
  closeWindowForMonth
};
