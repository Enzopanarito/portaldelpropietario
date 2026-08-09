'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {createRuntime}=require('./_shared/_provisional_access_runtime');

const handler=async function(){
 try{
  const result=await createRuntime().sweep();
  return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(result)};
 }catch(error){
  return{statusCode:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:false,message:'No se pudo revisar el vencimiento de los accesos provisionales.',detail:String(error.message||error).slice(0,300)})};
 }
};

exports.handler=withAirtableUsage('provisional-access-expiration-scheduled',handler);
