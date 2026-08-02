'use strict';

const ALIQUOTS=[0.08755,0.063884,0.06186,0.06731,0.07299,0.07159,0.06186,0.06186,0.06186,0.06186,0.06186,0.06186,0.06186,0.06186,0.07994];
const BALANCES=[
 {usd:85,bs:0},{usd:0,bs:0},{usd:0,bs:142.79},{usd:85,bs:201.27},{usd:85,bs:0},
 {usd:0,bs:0},{usd:85,bs:0},{usd:85,bs:0},{usd:-20,bs:0},{usd:170,bs:304.99},
 {usd:50,bs:-294.76},{usd:0,bs:99.99},{usd:85,bs:193.79},{usd:-50,bs:0},{usd:0,bs:169.91}
];

function money(value){return Math.round(Number(value||0)*100)/100}
function owner(index){
 const house=index+1,balance=BALANCES[index],usd=money(balance.usd),bs=money(balance.bs),total=money(usd+bs);
 return{
  id:`staging-house-${String(house).padStart(2,'0')}`,
  Casa:house,
  Propietario:`Propietario de prueba Casa ${house}`,
  Alicuota:ALIQUOTS[index],
  'Deuda Anterior':total,
  'Deuda Anterior USD':usd,
  'Deuda Anterior Bs Ref':bs,
  'Saldo USD Actual':usd,
  'Saldo Bs Ref Actual':bs,
  'Saldo Total Actual':total,
  'Deuda Restante':total,
  'Deuda Vencida USD':Math.max(0,usd),
  'Deuda Vencida Bs Ref':Math.max(0,bs),
  'Deuda Vencida Total':money(Math.max(0,usd)+Math.max(0,bs)),
  'Mes Corriente USD':0,
  'Mes Corriente Bs Ref':0,
  'Mes Corriente Total':0,
  'Recargo Aplicado':0,
  'Saldo a Favor':money(Math.max(0,-total)),
  'Saldo Oficial Activo':true,
  'Corte Saldo Oficial':'2026-08-02T00:00:00.000Z',
  'Estado Acceso Portón':'Habilitado',
  'Motivo Limitación Acceso':'Entorno de staging: MKJ deshabilitado',
  'Última Sync MKJ':''
 };
}
function payload(now=new Date()){
 return{
  generatedAt:now.toISOString(),
  generatedAtCaracas:new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(now),
  balanceEngineVersion:5,
  officialBalanceSource:'ControlVersiones',
  dataEnvironment:'staging-fixture',
  warning:'Datos sanitizados de respaldo para pruebas; no representan producción.',
  automation:{payment:{dueDay:10,surchargeRate:0.10},access:{mode:'Manual'}},
  propietarios:Array.from({length:15},(_,index)=>owner(index)),
  gastos:[],
  pagos:[]
 };
}
function isStagingEnvironment(env={}){return String(env.VLA_DATA_ENVIRONMENT||'').trim().toLowerCase()==='staging'}
function shouldFallback(result,env={}){
 if(!isStagingEnvironment(env))return false;
 if(!result||Number(result.statusCode)!==200)return true;
 try{const body=JSON.parse(result.body||'{}');return !Array.isArray(body.propietarios)||body.propietarios.length!==15}catch(_){return true}
}

module.exports={ALIQUOTS,BALANCES,money,owner,payload,isStagingEnvironment,shouldFallback};
