'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveAmounts}=require('../netlify/functions/admin-manual-payment')._test;

test('conserva la moneda realmente recibida sin mezclar la cuenta USD',()=>{
 assert.deepEqual(resolveAmounts({mode:'USD',enteredCurrency:'USD',amount:20,rate:250}),{ok:true,amountUsdRef:20,amountBs:0});
 assert.equal(resolveAmounts({mode:'USD',enteredCurrency:'BS',amount:5000,rate:250}).ok,false);
});

test('la cuenta Bs acepta bolívares o dólares con equivalencia auditable',()=>{
 assert.deepEqual(resolveAmounts({mode:'Bs BCV',enteredCurrency:'BS',amount:5000,rate:250}),{ok:true,amountUsdRef:20,amountBs:5000});
 assert.deepEqual(resolveAmounts({mode:'Bs BCV',enteredCurrency:'USD',amount:20,rate:250}),{ok:true,amountUsdRef:20,amountBs:5000});
});
