'use strict';

function money(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100) / 100
    : 0;
}

function ownerVisibleBalance(owner = {}) {
  const usd = money(owner['Saldo USD Actual']);
  const bsRef = money(owner['Saldo Bs Ref Actual']);
  const net = money(owner['Saldo Total Actual']);
  const payable = money(Math.max(0, usd) + Math.max(0, bsRef));

  // El portal muestra la suma de las cuentas que tienen deuda cuando existe
  // algo pagadero. Si ambas cuentas están en cero o a favor, muestra el saldo
  // neto negativo para identificar claramente el crédito del propietario.
  const visible = payable > 0.009 ? payable : net;

  return { usd, bsRef, net, payable, visible };
}

module.exports = { money, ownerVisibleBalance };
