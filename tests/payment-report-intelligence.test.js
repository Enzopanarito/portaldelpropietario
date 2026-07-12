'use strict';
const assert=require('assert');
const intelligence=require('../payment-report-intelligence');

(function parsesVenezuelanAndInternationalAmounts(){
  assert.equal(intelligence.parseAmountInput('15.300,00'),15300);
  assert.equal(intelligence.parseAmountInput('15,300.00'),15300);
  assert.equal(intelligence.parseAmountInput('15.300'),15300);
  assert.equal(intelligence.parseAmountInput('85,50'),85.5);
  assert.equal(intelligence.parseAmountInput('$ 85.00'),85);
})();

(function casa4UsdWrittenAsUsd(){
  const result=intelligence.analyzePayment({amount:85,rate:180,expectedUsd:85});
  assert.equal(result.status,'clear');assert.equal(result.enteredCurrency,'USD');assert.equal(result.amountUsdRef,85);
})();

(function casa4UsdWrittenAsBs(){
  const result=intelligence.analyzePayment({amount:15300,rate:180,expectedUsd:85});
  assert.equal(result.status,'clear');assert.equal(result.enteredCurrency,'BS');assert.equal(result.amountUsdRef,85);assert.equal(result.amountBs,15300);
})();

(function casa4BsDebtWrittenAsReferenceUsd(){
  const result=intelligence.analyzePayment({amount:221.40,rate:180,expectedUsd:221.40});
  assert.equal(result.status,'clear');assert.equal(result.enteredCurrency,'USD');assert.equal(result.amountUsdRef,221.40);
})();

(function casa4BsDebtWrittenAsBolivares(){
  const result=intelligence.analyzePayment({amount:39852,rate:180,expectedUsd:221.40});
  assert.equal(result.status,'clear');assert.equal(result.enteredCurrency,'BS');assert.equal(result.amountUsdRef,221.40);
})();

(function ambiguousRequiresUserChoice(){
  const result=intelligence.analyzePayment({amount:500,rate:180,expectedUsd:85});
  assert.equal(result.status,'ambiguous');
  const confirmed=intelligence.analyzePayment({amount:500,rate:180,expectedUsd:85,forcedCurrency:'BS'});
  assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.enteredCurrency,'BS');assert.equal(confirmed.amountUsdRef,2.78);
})();

(function solventOwnerCanReportAdvance(){
  const result=intelligence.analyzePayment({amount:100,rate:180,expectedUsd:0});
  assert.equal(result.status,'ambiguous');assert.equal(result.reason,'advance-or-no-balance');
  const confirmed=intelligence.analyzePayment({amount:100,rate:180,expectedUsd:0,forcedCurrency:'USD'});
  assert.equal(confirmed.isAdvance,true);assert.equal(confirmed.advanceUsd,100);
})();

(function missingRateBlocksBolivarConversion(){
  const result=intelligence.resolveAmount({amount:1000,enteredCurrency:'BS',rate:0});
  assert.equal(result.ok,false);assert.equal(result.reason,'missing-rate');
})();

console.log('payment-report-intelligence: OK');
