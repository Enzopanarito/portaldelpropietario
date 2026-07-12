(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.VLAPaymentIntelligence=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  function money(value){
    const number=Number(value);
    if(!Number.isFinite(number))return 0;
    return Math.round((number+Number.EPSILON)*100)/100;
  }

  function positive(value){
    const number=Number(value);
    return Number.isFinite(number)&&number>0?number:0;
  }

  function parseAmountInput(value){
    if(typeof value==='number')return Number.isFinite(value)&&value>0?money(value):0;
    let raw=String(value??'').trim().replace(/[^0-9.,-]/g,'');
    if(!raw||raw.includes('-'))return 0;
    const commas=(raw.match(/,/g)||[]).length,dots=(raw.match(/\./g)||[]).length;
    const normalizeWithDecimal=(separator)=>{
      const index=raw.lastIndexOf(separator);
      const integer=raw.slice(0,index).replace(/[.,]/g,'')||'0';
      const decimals=raw.slice(index+1).replace(/[.,]/g,'');
      return Number(integer+(decimals?'.'+decimals:''));
    };
    let parsed;
    if(commas&&dots){
      parsed=normalizeWithDecimal(raw.lastIndexOf(',')>raw.lastIndexOf('.')?',':'.');
    }else if(commas||dots){
      const separator=commas?',':'.',count=commas||dots,parts=raw.split(separator),tail=parts[parts.length-1];
      if(count>1){
        parsed=tail.length>0&&tail.length<=2?normalizeWithDecimal(separator):Number(parts.join(''));
      }else if(tail.length===1||tail.length===2){
        parsed=normalizeWithDecimal(separator);
      }else{
        parsed=Number(parts.join(''));
      }
    }else parsed=Number(raw);
    return Number.isFinite(parsed)&&parsed>0?money(parsed):0;
  }

  function relativeError(candidate,expected){
    const base=Math.max(Math.abs(expected),1);
    return Math.abs(candidate-expected)/base;
  }

  function resolveAmount({amount,enteredCurrency,rate}){
    const raw=positive(amount),fx=positive(rate),currency=String(enteredCurrency||'').toUpperCase();
    if(!raw)return{ok:false,reason:'invalid-amount',amountEntered:0,amountUsdRef:0,amountBs:0};
    if(currency==='USD')return{ok:true,enteredCurrency:'USD',amountEntered:money(raw),amountUsdRef:money(raw),amountBs:fx?money(raw*fx):0,rate:fx||0};
    if(currency==='BS'){
      if(!fx)return{ok:false,reason:'missing-rate',amountEntered:money(raw),amountUsdRef:0,amountBs:money(raw),rate:0};
      return{ok:true,enteredCurrency:'BS',amountEntered:money(raw),amountUsdRef:money(raw/fx),amountBs:money(raw),rate:fx};
    }
    return{ok:false,reason:'missing-currency',amountEntered:money(raw),amountUsdRef:0,amountBs:0,rate:fx||0};
  }

  function inferEnteredCurrency({amount,rate,expectedUsd}){
    const raw=positive(amount),fx=positive(rate),expected=positive(expectedUsd);
    if(!raw)return{status:'invalid',reason:'invalid-amount'};
    if(!fx)return{status:'ambiguous',reason:'missing-rate',candidates:{USD:money(raw),BS:null}};

    const usdCandidate=money(raw);
    const bsCandidate=money(raw/fx);
    const candidates={USD:usdCandidate,BS:bsCandidate};
    if(!expected)return{status:'ambiguous',reason:'advance-or-no-balance',candidates};

    const usdError=relativeError(usdCandidate,expected);
    const bsError=relativeError(bsCandidate,expected);
    const best=usdError<=bsError?'USD':'BS';
    const bestError=Math.min(usdError,bsError);
    const otherError=Math.max(usdError,bsError);

    const directMatch=bestError<=0.12&&otherError>=0.35;
    const strongRelativeLead=bestError<=0.22&&otherError>=Math.max(0.55,bestError*4);
    const nearExpectedUsd=usdCandidate>=expected*0.45&&usdCandidate<=expected*1.8;
    const nearExpectedBs=raw>=expected*fx*0.45&&raw<=expected*fx*1.8;
    const magnitudeLead=(best==='USD'&&nearExpectedUsd&&!nearExpectedBs)||(best==='BS'&&nearExpectedBs&&!nearExpectedUsd);

    if(directMatch||strongRelativeLead||magnitudeLead){
      const resolved=resolveAmount({amount:raw,enteredCurrency:best,rate:fx});
      return{status:'clear',enteredCurrency:best,confidence:directMatch?'high':'medium',expectedUsd:money(expected),errors:{USD:usdError,BS:bsError},candidates,...resolved};
    }
    return{status:'ambiguous',reason:'similar-or-unmatched',expectedUsd:money(expected),errors:{USD:usdError,BS:bsError},candidates};
  }

  function analyzePayment({amount,rate,expectedUsd,forcedCurrency}){
    const forced=String(forcedCurrency||'').toUpperCase();
    let result;
    if(forced==='USD'||forced==='BS'){
      const resolved=resolveAmount({amount,enteredCurrency:forced,rate});
      result=resolved.ok?{status:'confirmed',confidence:'user',...resolved}:{status:'invalid',...resolved};
    }else result=inferEnteredCurrency({amount,rate,expectedUsd});

    if((result.status==='clear'||result.status==='confirmed')&&result.ok!==false){
      const expected=positive(expectedUsd),usdRef=positive(result.amountUsdRef);
      return{
        ...result,
        expectedUsd:money(expected),
        isAdvance:expected<=0.01,
        exceedsBalance:expected>0.01&&usdRef>expected+0.01,
        advanceUsd:expected>0.01?money(Math.max(0,usdRef-expected)):money(usdRef)
      };
    }
    return result;
  }

  return{money,parseAmountInput,resolveAmount,inferEnteredCurrency,analyzePayment};
});