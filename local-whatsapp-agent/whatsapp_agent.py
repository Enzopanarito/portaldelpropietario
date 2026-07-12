#!/usr/bin/env python3
import json, os, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parent
ENV_PATH=ROOT/'.env'
TOKEN_CACHE=None
AGENT_VERSION='2.0'

class ApiError(RuntimeError):
    def __init__(self,message,status=0): super().__init__(message); self.status=status

def load_env():
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding='utf-8').splitlines():
            line=line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k,v=line.split('=',1); os.environ.setdefault(k.strip(),v.strip().strip('"').strip("'"))

def req(url,method='GET',token=None,payload=None):
    data=None if payload is None else json.dumps(payload).encode('utf-8')
    headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    request=urllib.request.Request(url,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(request,timeout=60) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        body=error.read().decode('utf-8','replace')
        try: detail=json.loads(body).get('message') or json.loads(body).get('detail') or body
        except Exception: detail=body
        raise ApiError(str(detail)[:500],error.code)

def login(portal,force=False):
    global TOKEN_CACHE
    if TOKEN_CACHE and not force: return TOKEN_CACHE
    configured=os.environ.get('ADMIN_TOKEN','').strip()
    if configured and not force: TOKEN_CACHE=configured; return TOKEN_CACHE
    password=os.environ.get('ADMIN_PASSWORD','').strip()
    if not password: raise RuntimeError('Falta ADMIN_PASSWORD en .env para renovar la sesión.')
    data=req(portal+'/.netlify/functions/login','POST',payload={'password':password})
    if not data.get('success') or not data.get('token'): raise RuntimeError('No pude iniciar sesión en el portal.')
    TOKEN_CACHE=data['token']; return TOKEN_CACHE

def api(portal,resource='jobs',method='GET',payload=None):
    global TOKEN_CACHE
    url=portal+'/.netlify/functions/whatsapp-jobs'
    if method=='GET': url+='?resource='+resource
    token=login(portal)
    try: return req(url,method,token,payload)
    except ApiError as error:
        if error.status!=401: raise
        TOKEN_CACHE=None
        return req(url,method,login(portal,force=True),payload)

def parse_summary(output):
    for line in reversed(output.splitlines()):
        if line.startswith('SUMMARY_JSON:'): return json.loads(line.split('SUMMARY_JSON:',1)[1])
    return {'enviados':0,'simulados':0,'errores':1,'procesados':0}

def run_sender(job):
    excel=ROOT/os.environ.get('EXCEL_FILE','Sistema_WhatsApp_Controlado_v4.xlsx')
    if not excel.exists(): raise FileNotFoundError('No encontré el Excel requerido: '+str(excel))
    mode='real' if job.get('mode')=='Envío real' else 'simulacion'
    command=[sys.executable,str(ROOT/'enviar_recordatorios_morosos_portal.py'),'--modo',mode,'--job-id',job['jobId'],'--excel',str(excel),'--log',str(ROOT/os.environ.get('LOG_FILE','registro_envios.txt'))]
    if job.get('avoidDuplicates'): command.append('--avoid-duplicates')
    if job.get('force'): command.append('--force')
    process=subprocess.run(command,cwd=str(ROOT),text=True,capture_output=True)
    output=(process.stdout or '')+('\n'+process.stderr if process.stderr else '')
    return process.returncode,output[-8000:],parse_summary(output)

def heartbeat(portal,mac,status='online'):
    return api(portal,method='POST',payload={'action':'heartbeat','executedBy':mac,'status':status,'version':AGENT_VERSION})

def run_scheduler_if_due(portal):
    try:
        result=api(portal,method='POST',payload={'action':'runScheduler'})
        count=int(result.get('createdCount',0))
        if count: print(f'Programación revisada: {count} orden(es) creada(s).')
        return count
    except Exception as error:
        print('Advertencia: no pude revisar programaciones:',error); return 0

def process_once(portal,mac_name):
    heartbeat(portal,mac_name,'online')
    run_scheduler_if_due(portal)
    jobs=api(portal,'due-jobs').get('jobs',[])
    if not jobs: print('Sin órdenes pendientes.'); return 0
    processed=0
    for job in jobs:
        jid=job['jobId']; print('Intentando tomar orden',jid,job.get('mode'))
        try:
            claimed=api(portal,method='POST',payload={'action':'claimJob','jobId':jid,'executedBy':mac_name})
            if not claimed.get('success'): print('Orden no tomada:',jid); continue
        except ApiError as error:
            if error.status==409: print('Orden ya tomada por otro agente:',jid); continue
            raise
        try:
            code,log,summary=run_sender(job)
            status='Completado' if code==0 and int(summary.get('errores',0))==0 else 'Error'
            api(portal,method='POST',payload={'action':'finishJob','jobId':jid,'status':status,'sent':int(summary.get('enviados',0)),'simulated':int(summary.get('simulados',0)),'errors':int(summary.get('errores',0)),'log':log})
            print('Orden finalizada:',jid,status); processed+=1
        except Exception as error:
            print('Error procesando',jid,error)
            try: api(portal,method='POST',payload={'action':'finishJob','jobId':jid,'status':'Error','errors':1,'log':str(error)})
            except Exception: pass
    return processed

if __name__=='__main__':
    load_env(); portal=os.environ.get('PORTAL_URL','https://villalosapamates.netlify.app').rstrip('/'); interval=max(60,int(os.environ.get('CHECK_INTERVAL_SECONDS','120'))); mac=os.environ.get('MAC_NAME','Mac local'); once='--once' in sys.argv
    while True:
        try: process_once(portal,mac)
        except Exception as error:
            print('Error general:',error)
            try: heartbeat(portal,mac,'error')
            except Exception: pass
        if once: break
        time.sleep(interval)
