'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const score = require('../netlify/functions/_shared/_punctuality_score_v3');

function rec(casa,label,amount,created,id){
  return {id:id||`rec${Math.random().toString(36).slice(2,16)}`.slice(0,17),createdTime:created,fields:{Concepto:`AUDITORIA|2026-07|Casa ${casa}|${label} | Prueba`,'Monto Cargado':amount}};
}

test('si total auditado contradice USD + Bs, el índice usa los componentes sin tocar los registros originales',()=>{
  const history=[
    rec(6,'Saldo final Bs Ref',0,'2026-08-01T07:04:08.000Z','recBS000000000006'),
    rec(6,'Saldo final total (Solvente)',0,'2026-08-01T07:04:08.000Z','recTOT00000000006'),
    rec(6,'Saldo final USD',0,'2026-08-01T07:04:08.000Z','recUSD00000000006'),
    rec(6,'Saldo final total (Deuda)',85,'2026-08-02T04:03:03.000Z','recBAD00000000006')
  ];
  const before=JSON.stringify(history);
  const reconciled=score.reconcileAuditHistory(history);
  assert.equal(JSON.stringify(history),before);
  assert.equal(reconciled.filter(r=>String(r.fields.Concepto).includes('Saldo final total')).length,1);
  const snapshot=score.parseAuditSnapshots(reconciled).get('2026-07|6');
  assert.equal(score.auditFinalBalance(snapshot),0);
  assert.equal(score.auditCutoff(snapshot),'2026-08-01T07:04:08.000Z');
});

test('el resultado no depende del orden en que Airtable entregue totales contradictorios',()=>{
  const rows=[
    rec(6,'Saldo final USD',0,'2026-08-01T07:04:08.000Z','recUSD00000000006'),
    rec(6,'Saldo final Bs Ref',0,'2026-08-01T07:04:08.000Z','recBS000000000006'),
    rec(6,'Saldo final total (Solvente)',0,'2026-08-01T07:04:08.000Z','recTOT00000000006'),
    rec(6,'Saldo final total (Deuda)',85,'2026-08-02T04:03:03.000Z','recBAD00000000006')
  ];
  const a=score.parseAuditSnapshots(score.reconcileAuditHistory(rows)).get('2026-07|6');
  const b=score.parseAuditSnapshots(score.reconcileAuditHistory(rows.slice().reverse())).get('2026-07|6');
  assert.equal(score.auditFinalBalance(a),0);
  assert.equal(score.auditFinalBalance(b),0);
  assert.equal(score.auditCutoff(a),score.auditCutoff(b));
});

test('un total único consistente no se altera',()=>{
  const rows=[
    rec(7,'Saldo final USD',20,'2026-08-01T07:04:07.000Z','recUSD00000000007'),
    rec(7,'Saldo final Bs Ref',0,'2026-08-01T07:04:07.000Z','recBS000000000007'),
    rec(7,'Saldo final total (Deuda)',20,'2026-08-01T07:04:07.000Z','recTOT00000000007')
  ];
  assert.strictEqual(score.reconcileAuditHistory(rows),rows);
});
