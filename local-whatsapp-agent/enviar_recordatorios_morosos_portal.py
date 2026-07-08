#!/usr/bin/env python3
import argparse,json,os,sys,time,unicodedata
from datetime import datetime
import pandas as pd
import pywhatkit

def normalizar(t):
    t=str(t or '').strip().lower(); t=unicodedata.normalize('NFKD',t); return ' '.join(''.join(c for c in t if not unicodedata.combining(c)).replace('-',' ').replace('_',' ').split())
def num(v):
    try: return float(v) if not pd.isna(v) else 0.0
    except Exception: return 0.0
def fmt(v): return f'{num(v):.2f}'
def tel(raw):
    s=str(raw).strip().replace(' ','').replace('-','')
    return s if s.startswith('+') else '+58'+s[-10:]
def pronto(day):
    if day<10: return f'Recuerda que estás dentro del periodo de pronto pago. Te quedan {10-day} días de ese beneficio.'
    if day==10: return 'Recuerda: Hoy es el último día para aprovechar el beneficio de pronto pago.'
    return ''
def get(row,colmap,cands):
    for c in cands:
        if normalizar(c) in colmap: return num(row[colmap[normalizar(c)]])
    return 0.0
def ya_enviado(log_path,telefono,fecha):
    if not os.path.exists(log_path): return False
    try: txt=open(log_path,'r',encoding='utf-8').read()
    except Exception: return False
    return fecha in txt and telefono in txt and 'Mensaje enviado' in txt
def mensaje(nombre,fecha,cond,gasoil,cuota,total,linea):
    lines=[]
    if cond>0: lines.append(f'• Gastos de condominio: ${fmt(cond)}')
    if gasoil>0: lines.append(f'• Gasoil: ${fmt(gasoil)}')
    if cuota>0: lines.append(f'• Cuota Especial: ${fmt(cuota)}')
    nota='*Nota:* Pagos en Bs. se calculan a la tasa oficial del BCV del día. Gasoil y Cuota Especial deben pagarse exclusivamente en divisas.'
    extra='\n\n'+linea+'\n' if linea else '\n'
    return f'*Asunto: Recordatorio de Saldo Pendiente*\n\n📅 _Mensaje generado el {fecha}_\n\nEstimado/a *{nombre}*,\n\nLe contactamos para informarle que su propiedad presenta el siguiente saldo:\n\n'+'\n'.join(lines)+f'\n\n*TOTAL A PAGAR: ${fmt(total)}*\n\nAgradecemos su pronta gestión.{extra}Para más información, visite nuestro portal:\nhttps://villalosapamates.netlify.app\n\n{nota}'
def main():
    p=argparse.ArgumentParser(); p.add_argument('--excel',default='Sistema_WhatsApp_Controlado_v4.xlsx'); p.add_argument('--log',default='registro_envios.txt'); p.add_argument('--modo',choices=['simulacion','real'],default='simulacion'); p.add_argument('--job-id',default='manual'); p.add_argument('--avoid-duplicates',action='store_true'); p.add_argument('--force',action='store_true'); p.add_argument('--wait-time',type=int,default=15); p.add_argument('--sleep',type=int,default=30); a=p.parse_args()
    fecha=datetime.now().strftime('%d/%m/%Y'); line=pronto(datetime.now().day)
    with open(a.log,'a',encoding='utf-8') as f: f.write(f'[{datetime.now().strftime("%d/%m/%Y - %H:%M")}] Job {a.job_id}: modo {a.modo}.\n')
    if not os.path.exists(a.excel): raise FileNotFoundError('No encontré el Excel: '+a.excel)
    raw=pd.read_excel(a.excel,header=None); header=None
    for i,row in raw.iterrows():
        if row.astype(str).str.contains('Casa',case=False).any(): header=i; break
    if header is None: raise ValueError('No pude detectar encabezados.')
    df=pd.read_excel(a.excel,header=header); colmap={normalizar(c):c for c in df.columns}
    nombre_col=colmap.get('nombre','Nombre'); tel_col=colmap.get('telefonos','Telefonos')
    df=df[df[tel_col].notna()].copy(); df['__total__']=df.apply(lambda r:get(r,colmap,['total','total pagar','total a pagar']),axis=1); df=df[df['__total__']>0]
    enviados=simulados=errores=omitidos=procesados=0
    for _,row in df.iterrows():
        procesados+=1
        try:
            nombre=row[nombre_col]; telefono=tel(row[tel_col]); total=num(row['__total__']); gasoil=get(row,colmap,['gasoil','gasoil usd','gasoil $']); cuota=get(row,colmap,['cuota especial','cuota especial usd','cuota especial $']); cond=max(0,total-gasoil-cuota); msg=mensaje(nombre,fecha,cond,gasoil,cuota,total,line)
            if a.modo=='real':
                if a.avoid_duplicates and not a.force and ya_enviado(a.log,telefono,fecha): omitidos+=1; continue
                pywhatkit.sendwhatmsg_instantly(telefono,msg,wait_time=a.wait_time,tab_close=True); enviados+=1; time.sleep(a.sleep); pref='Mensaje enviado'
            else:
                print(f'📤 Simulación a {nombre} ({telefono}):\n{msg}\n'); simulados+=1; pref='Simulación de mensaje'
            with open(a.log,'a',encoding='utf-8') as f: f.write(f'[{fecha} - {datetime.now().strftime("%H:%M")}] {pref} a {nombre} ({telefono}) Total ${fmt(total)}\n')
        except Exception as e:
            errores+=1; print('Error:',e)
    summary={'job_id':a.job_id,'procesados':procesados,'enviados':enviados,'simulados':simulados,'omitidos':omitidos,'errores':errores,'modo':a.modo}
    print('SUMMARY_JSON:'+json.dumps(summary,ensure_ascii=False)); return 1 if errores else 0
if __name__=='__main__': sys.exit(main())
