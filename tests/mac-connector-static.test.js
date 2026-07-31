'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..','mac-connector');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'chrome-extension','manifest.json'),'utf8'));
const background=fs.readFileSync(path.join(root,'chrome-extension','background.js'),'utf8');
const content=fs.readFileSync(path.join(root,'chrome-extension','whatsapp-content.js'),'utf8');
const install=fs.readFileSync(path.join(root,'scripts','install.sh'),'utf8');
const uninstall=fs.readFileSync(path.join(root,'scripts','uninstall.sh'),'utf8');
const rollback=fs.readFileSync(path.join(root,'scripts','rollback-latest.sh'),'utf8');
const support=fs.readFileSync(path.join(root,'Sources','VLAConnectorCore','Support.swift'),'utf8');
const api=fs.readFileSync(path.join(root,'Sources','VLAConnectorCore','APIClient.swift'),'utf8');
const runner=fs.readFileSync(path.join(root,'Sources','VLAConnectorCore','ConnectorRunner.swift'),'utf8');

function extensionIdFromKey(key){
  const digest=crypto.createHash('sha256').update(Buffer.from(key,'base64')).digest().subarray(0,16);
  return [...digest].map(byte=>String.fromCharCode(97+(byte>>4),97+(byte&15))).join('');
}

const expectedId='oopmhhmkihemkkjghmpepgfcmcomplph';
assert.strictEqual(manifest.manifest_version,3);
assert.strictEqual(extensionIdFromKey(manifest.key),expectedId,'La clave pública debe conservar el ID fijo de la extensión.');
assert.deepStrictEqual(new Set(manifest.permissions),new Set(['nativeMessaging','tabs','storage']));
assert.deepStrictEqual(manifest.host_permissions,['https://web.whatsapp.com/*']);
assert.deepStrictEqual(manifest.externally_connectable.matches,['https://villalosapamates.netlify.app/*']);
assert(!manifest.permissions.includes('debugger'));
assert(!manifest.permissions.includes('webRequest'));
assert(!manifest.permissions.includes('<all_urls>'));
assert(!JSON.stringify(manifest).includes('127.0.0.1'));
assert(!JSON.stringify(manifest).includes('localhost'));

assert(background.includes("const PORTAL_ORIGIN = 'https://villalosapamates.netlify.app'"));
assert(background.includes("const NATIVE_HOST = 'com.villaslosapamates.whatsapp_connector'"));
assert(background.includes('let activeDispatch = null'));
assert(background.includes('if (activeDispatch) throw new Error'));
assert(background.includes('prepareWhatsApp'));
assert(background.includes('commitWhatsApp'));
assert(!background.includes('chrome.debugger'));
assert(!background.includes('localStorage.setItem'));
assert(!background.includes('dispatchToken: message.dispatchToken, mode: message.mode, save'));

const prepareStart=content.indexOf('async function prepare(');
const commitStart=content.indexOf('async function commit(');
assert(prepareStart>0&&commitStart>prepareStart);
const prepareBody=content.slice(prepareStart,commitStart);
const commitBody=content.slice(commitStart,content.indexOf('chrome.runtime.onMessage'));
assert(!prepareBody.includes('.click()'),'Preparar jamás debe activar Enviar.');
assert(commitBody.includes('button.click()'),'Solo Confirmar puede activar Enviar.');
assert(commitBody.includes("status: 'verify'"),'La incertidumbre debe producir Verificar.');
assert(content.includes('crypto.subtle.digest'));
assert(content.includes('messageHash'));
assert(content.includes('chatPhoneMatch'));
assert(content.includes('composerCleared'));
assert(content.includes('outgoingBubble'));

for(const script of [install,uninstall,rollback]){
  assert(script.startsWith('#!/bin/bash'));
  assert(script.includes('set -euo pipefail'));
  assert(!/\bsudo\b/.test(script));
  assert(!script.includes('curl | sh'));
}
assert(install.includes('Install Backups'));
assert(install.includes('allowed_origins'));
assert(install.includes(`chrome-extension://\${extension_id}/`)||install.includes('chrome-extension://'));
assert(install.includes(expectedId));
assert(install.includes('swift test'));
assert(uninstall.includes('--purge-data'));
assert(rollback.includes('Restaurando respaldo'));

assert(support.includes('posixPermissions: 0o600'));
assert(support.includes('device-id'));
assert(api.includes('ConnectorSupport.authorizedEndpoint'));
assert(!runner.includes('pywhatkit'));
assert(!runner.includes('pyautogui'));
assert(!runner.includes('AppleScript'));
assert(runner.includes('outcome: "verify"'));
assert(runner.indexOf('outcome: "sending"')<runner.indexOf('commit_message'));

console.log('MAC_CONNECTOR_STATIC_TESTS_OK');
