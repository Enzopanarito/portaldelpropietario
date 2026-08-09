'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateManualAccessRequest}=require('../netlify/functions/_shared/_manual_access_policy');

test('permite la acción que coincide con la deuda en modo automático',()=>{
 assert.equal(evaluateManualAccessRequest({action:'disable',mode:'Automático',hasExpiredDebt:true}).allowed,true);
 assert.equal(evaluateManualAccessRequest({action:'enable',mode:'Automático',hasExpiredDebt:false}).allowed,true);
});

test('bloquea una contradicción silenciosa y exige excepción auditada',()=>{
 const enable=evaluateManualAccessRequest({action:'enable',mode:'Automático',hasExpiredDebt:true});
 assert.equal(enable.allowed,false);
 assert.equal(enable.code,'ACCESS_EXCEPTION_REQUIRED');
 const disable=evaluateManualAccessRequest({action:'disable',mode:'Automático',hasExpiredDebt:false});
 assert.equal(disable.allowed,false);
 assert.equal(disable.code,'ACCESS_EXCEPTION_REQUIRED');
});

test('solo autoriza una excepción nueva con motivo suficiente',()=>{
 const short=evaluateManualAccessRequest({action:'enable',mode:'Automático',hasExpiredDebt:true,exceptionRequested:true,reason:'urgente'});
 assert.equal(short.allowed,false);
 assert.equal(short.code,'ACCESS_EXCEPTION_REASON_REQUIRED');
 const audited=evaluateManualAccessRequest({action:'enable',mode:'Automático',hasExpiredDebt:true,exceptionRequested:true,reason:'Emergencia familiar autorizada'});
 assert.equal(audited.allowed,true);
 assert.equal(audited.createException,true);
 assert.equal(audited.exception,true);
});

test('el modo manual conserva el control directo',()=>{
 const result=evaluateManualAccessRequest({action:'enable',mode:'Manual',hasExpiredDebt:true});
 assert.equal(result.allowed,true);
 assert.equal(result.manualMode,true);
 assert.equal(result.exception,false);
});
