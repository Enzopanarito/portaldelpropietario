#!/usr/bin/env python3
import json, os, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parent
ENV_PATH=ROOT/'.env'
def load_env():
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding='utf-8').splitlines():
            line=line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k,v=line.split('=',1); os.environ.setdefault(k.strip(),v.strip().strip('"').strip("'"))
def req(url,method='GET',token=None,payload=None):
    data=None if payload is None else json.dumps(payload).encode('utf-8')
    h={'Content-Type':'application/json'}
    if token: h['Authorization']='Bearer '+token
    r=urllib.request.Request(url,data=data,headers=h,method=method)
    with urllib.request.urlopen(r,timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8'))
def login(portal):
    token=os.environ.get('ADMIN_TOKEN')
    if token: return token
    password=os.environ.get('ADMIN_PASSWORD')
    if not password: raise RuntimeError('Falta ADMIN_PASSWORD en .env')
    d=req(portal+'/.netlify/functions/login','POST',payload={'password':password})
    if not d.get('success'): raise RuntimeError('No pude iniciar sesión')
    return d['token']
def api(portal,token,resource='jobs',method='GET',payload=None):
    url=portal+'/.netlify/functions/whatsapp-jobs'
    if method=='GET': url+='?resource='+resource
    return req(url,method,token,payload)
def parse_summary(out):
    for line in reversed(out.splitlines()):
        if line.startswith('SUMMARY_JSON:'):
            return json.loads(line.split('SUMMARY_JSON:',1)[1])
    return {'enviados':0,'simulados':0,'errores':1,'procesados':0}
def run_sender(job):
    mode='real' if job.get('mode')=='Envío real' else 'simulacion'
    cmd=[sys.executable,str(ROOT/'enviar_recordatorios_morosos_portal.py'),'--modo',mode,'--job-id',job['jobId'],'--excel',str(ROOT/os.environ.get('EXCEL_FILE','Sistema_WhatsApp_Controlado_v4.xlsx')),'--log',str(ROOT/os.environ.get('LOG_FILE','registro_envios.txt'))]
    if job.get('avoidDuplicates'): cmd.append('--avoid-duplicates')
    if job.get('force'): cmd.append('--force')
    proc=subprocess.run(cmd,cwd=str(ROOT),text=True,capture_output=True)
    out=(proc.stdout or '')+('\n'+proc.stderr if proc.stderr else '')
    return proc.returncode,out[-8000:],parse_summary(out)
def process_once(portal,token,mac_name):
    jobs=api(portal,token,'due-jobs').get('jobs',[])
    if not jobs:
        print('Sin órdenes pendientes.'); return 0
    n=0
    for job in jobs:
        jid=job['jobId']; print('Tomando orden',jid,job.get('mode'))
        try:
            api(portal,token,method='POST',payload={'action':'claimJob','jobId':jid,'executedBy':mac_name})
            code,log,summary=run_sender(job)
            status='Completado' if code==0 and int(summary.get('errores',0))==0 else 'Error'
            api(portal,token,method='POST',payload={'action':'finishJob','jobId':jid,'status':status,'sent':int(summary.get('enviados',0)),'simulated':int(summary.get('simulados',0)),'errors':int(summary.get('errores',0)),'log':log})
            print('Orden finalizada:',jid,status); n+=1
        except Exception as e:
            print('Error procesando',jid,e)
            try: api(portal,token,method='POST',payload={'action':'finishJob','jobId':jid,'status':'Error','errors':1,'log':str(e)})
            except Exception: pass
    return n
if __name__=='__main__':
    load_env(); portal=os.environ.get('PORTAL_URL','https://villalosapamates.netlify.app').rstrip('/'); interval=int(os.environ.get('CHECK_INTERVAL_SECONDS','120')); mac=os.environ.get('MAC_NAME','Mac local')
    once='--once' in sys.argv
    while True:
        try:
            token=login(portal); process_once(portal,token,mac)
        except Exception as e: print('Error general:',e)
        if once: break
        time.sleep(interval)
