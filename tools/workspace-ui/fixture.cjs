// Disposable, loopback-only fixture: no real Electron profile, provider, accounts or tokens.
const fs = require('fs');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');
const project = process.argv[2] || process.cwd();
const port = Number(process.argv[3] || 8087);
const out =
  process.env.OPERATOR_FIXTURE_DIR ||
  path.join(require('os').tmpdir(), `operator-workspace-fixture-${port}`);
fs.mkdirSync(out, { recursive: true });
const sdk = `
class Events { constructor(){this.events={}} on(e,f){(this.events[e] ||= []).push(f)} emit(e,...a){(this.events[e]||[]).forEach(f=>f(...a))} }
class Call extends Events {constructor(to, incoming=false){super();this.parameters={To:to,From:incoming?to:'client:operator-demo',CallSid:'CAfixture'+Date.now()};this.direction=incoming?'INCOMING':'OUTGOING';this.s=incoming?'pending':'open';this.m=false;}status(){return this.s}isMuted(){return this.m}mute(v){this.m=v}accept(){this.s='open';this.emit('accept')}reject(){this.s='closed';this.emit('reject')}disconnect(){this.s='closed';this.emit('disconnect')}sendDigits(d){window.__fixture.digits.push(d)}}
export class Device extends Events {constructor(){super();this.state='unregistered';window.__fixture.device=this}async register(){this.state='registered';this.emit('registered')}async destroy(){}async connect({params}){window.__fixture.calls.push(params.To);return new Call(params.To)}updateToken(){}}
window.__fixture.incoming=(n)=>{const call=new Call(n,true);window.__fixture.incomingCall=call;window.__fixture.device.emit('incoming',call)};
`;
fs.writeFileSync(path.join(out, 'sdk.js'), sdk);
fs.writeFileSync(
  path.join(out, 'entry.jsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(path.join(project, 'src/App.js'))};createRoot(document.getElementById('root')).render(<App/>);`,
);
const bridge = `
window.__fixture={calls:[],digits:[],notifications:[]};
const A='+12025550101',B='+12025550102',t=1781856000000;
let db=JSON.parse(localStorage.getItem('fixture-db')||'null')||{[A]:{number:A,messages:[{sid:'SMfixture1',at:t,body:'Can we meet at 2 tomorrow?',direction:'inbound',status:'received'},{sid:'SMfixture2',at:t+60000,body:'Yes, see you then.',direction:'outbound',status:'delivered'}]},[B]:{number:B,messages:[{sid:'SMfixture3',at:t-86400000,body:'Please confirm the address.',direction:'inbound',status:'received'}]}};
const save=()=>localStorage.setItem('fixture-db',JSON.stringify(db));
const thread=(n)=>{let c=db[n];if(!c)return{ok:false,error:'no such conversation'};let m=c.messages.at(-1);return{...c,lastMessageAt:m?.at||0,lastBody:m?.body||'',lastDirection:m?.direction||null,messageCount:c.messages.length}};
const cfg=()=>JSON.parse(localStorage.getItem('fixture-config')||'null')||{accountSid:'AC00000000000000000000000000000000',identity:'operator-demo'};
let subs={};
// A fictional stand-in for the setup bridge (window.operator.setup): the browser journey
// checks the screens and what the page sends; the real service is exercised by the
// Electron journey and src/setup.test.js. Starts connected unless the page was left fresh.
const SID='AC'+'1'.repeat(32),NUM1='PN'+'a'.repeat(32),NUM2='PN'+'b'.repeat(32);
const sstate=()=>JSON.parse(localStorage.getItem('fixture-setup')||'null')||{connected:true};
const setSstate=(v)=>localStorage.setItem('fixture-setup',JSON.stringify(v));
window.__fixture.setupCalls=[];
const route=(state,description)=>({state,description,fingerprint:'f'+description.length});
const setup={
 status:async()=>{const c=sstate().connected;return{ok:true,available:true,credentials:c,accountSid:c?SID:null,hasAuthToken:c,number:c?'+12025550100':null,identity:c?'operator-demo':null,publicBaseUrl:null,publicBaseUrlSource:null,connected:c,connection:{checkedAt:c?1781856000000:null,account:{state:c?'ok':'unchecked',detail:null},voice:c?{state:'operator',description:'Operator'}:null,sms:c?{state:'operator',description:'Operator'}:null,callback:{state:'no-public-address',url:null},mms:c?'yes':'unknown'}}},
 check:async(i)=>{window.__fixture.setupCalls.push({action:'check',input:i});
  if(i.authToken==='wrong-token')return{ok:false,kind:'invalid-credentials',error:'Twilio did not accept this Account SID and Auth Token. Check them in the Twilio console.'};
  if(i.authToken==='offline-token')return{ok:false,kind:'unreachable',error:'Could not reach Twilio. Check your internet connection; your Twilio settings were not changed.'};
  return{ok:true,account:{sid:i.accountSid},more:false,numbers:[
   {sid:NUM1,e164:'+12025550100',friendlyName:'Fictional line',capabilities:{voice:true,sms:true,mms:true},current:false,voice:route('blank','not set'),sms:route('blank','not set')},
   {sid:NUM2,e164:'+12025550177',friendlyName:'Fictional office',capabilities:{voice:true,sms:true,mms:false},current:false,voice:route('foreign','https://elsewhere.example/voice'),sms:route('operator','Operator')}]}},
 review:async(i)=>{window.__fixture.setupCalls.push({action:'review',input:i});
  const foreign=i.numberSid===NUM2;
  return{ok:true,number:{sid:i.numberSid,e164:foreign?'+12025550177':'+12025550100',capabilities:{voice:true,sms:true,mms:!foreign}},publicBaseUrl:i.publicBaseUrl,rows:[
   {id:'key',label:'API key',action:'create',detail:'Create one API key named for Operator. Its secret is saved to server/.env and not shown.'},
   {id:'app',label:'TwiML App',action:'create',detail:'Create one TwiML App for Operator with voice, message and delivery addresses on '+i.publicBaseUrl+'.',changes:[{field:'Voice URL',from:'not set',to:i.publicBaseUrl+'/twiml'}]},
   foreign?{id:'voice',label:'Incoming calls',action:'replace',foreign:true,current:'https://elsewhere.example/voice',fingerprint:'abc123',detail:'The number\\'s voice route currently goes to https://elsewhere.example/voice, which is not Operator.'}:{id:'voice',label:'Incoming calls',action:'update',current:'not set',fingerprint:'n',detail:'The number\\'s voice route is not set. Set it to Operator.'},
   {id:'sms',label:'Incoming texts',action:foreign?'unchanged':'update',current:'x',fingerprint:'s',detail:foreign?'The number\\'s text route already goes to Operator.':'The number\\'s text route is not set. Set it to Operator.',notes:['If you later add this number to a Messaging Service, that service\\'s own setting overrides the number\\'s; Operator does not edit Messaging Services.']},
   {id:'identity',label:'Identity',action:'update',detail:'This app registers as "'+i.identity+'" and incoming calls ring the same identity.'}]}},
 connect:async(i)=>{window.__fixture.setupCalls.push({action:'connect',input:i});
  const skipped=i.numberSid===NUM2&&!(i.replace&&i.replace.voice);
  if(i.authToken==='fail-app-token'&&!window.__fixture.appFixed)return{ok:false,failedStep:'app',error:'Could not reach Twilio.',steps:[{id:'key',label:'API key',status:'done',detail:'Created API key SK1 and saved it to server/.env.'},{id:'app',label:'TwiML App',status:'failed',detail:'Could not reach Twilio.'},{id:'voice',label:'Incoming calls',status:'pending'},{id:'sms',label:'Incoming texts',status:'pending'},{id:'settings',label:'Save to server/.env',status:'pending'}],warnings:[]};
  setSstate({connected:true});
  return{ok:true,warnings:[],steps:[{id:'key',label:'API key',status:'done',detail:'Created API key SK1 and saved it to server/.env.'},{id:'app',label:'TwiML App',status:'done',detail:'Created the TwiML App AP1.'},{id:'voice',label:'Incoming calls',status:skipped?'skipped':'done',detail:skipped?'Left on https://elsewhere.example/voice, as you chose. Incoming calls will not reach this app.':'Set incoming calls to Operator.'},{id:'sms',label:'Incoming texts',status:'done',detail:'Set incoming texts to Operator.'},{id:'settings',label:'Save to server/.env',status:'done',detail:'Saved the account, number and identity to server/.env.'}]}},
 repair:async()=>({ok:true,result:'ok',changes:[],warnings:[]})};
window.__fixture.setSetup=(v)=>setSstate(v);
window.operator={invoke:async()=>true,config:{get:async(k)=>k?cfg()[k]:cfg(),set:async(k,v)=>{localStorage.setItem('fixture-config',JSON.stringify({...cfg(),[k]:v}));return v}},setup,token:{fetch:async()=>({ok:true,token:'fixture-not-a-real-token'})},sms:{list:async(o)=>o?.number?{ok:true,...thread(o.number)}:{ok:true,callerId:'+12025550100',smsFrom:'+12025550100',conversations:Object.keys(db).map(thread).sort((a,b)=>b.lastMessageAt-a.lastMessageAt)},me:async()=>({ok:true,smsFrom:'+12025550100'}),clear:async({number})=>{db[number]={number,messages:[]};save();return{ok:true,...thread(number)}},send:async({to,body})=>{if(body.includes('[unknown]')) throw new Error('Connection closed before confirmation');const fail=body.includes('[fail]');let m={sid:'SMfixture'+Date.now(),body,at:Date.now(),direction:'outbound',status:fail?'failed':'sent'};(db[to]||={number:to,messages:[]}).messages.push(m);save();return fail?{ok:false,error:'The destination is unavailable',status:'failed'}:{ok:true,sid:m.sid,status:'sent'}}},notifications:{show:async(v)=>{window.__fixture.notifications.push(v);return{ok:true}}},on:(e,f)=>{(subs[e]||=[]).push(f);return()=>subs[e]=subs[e].filter(x=>x!==f)},app:{platform:async()=>'fixture',version:async()=>'fixture'}};
window.__fixture.inbound=(number,body)=>{(db[number]||={number,messages:[]}).messages.push({sid:'SMinbound'+Date.now(),body,at:Date.now(),direction:'inbound',status:'received'});save()};
window.__fixture.notificationClick=(number)=>(subs['sms:open']||[]).forEach(f=>f({number}));
window.__fixture.addHistory=(number)=>{for(let i=0;i<40;i++)db[number].messages.unshift({sid:'SMold'+i,at:t-i*60000,body:'Meeting notes, item '+(i+1)+': please bring the documents.',direction:'inbound',status:'received'});save()};
`;
(async () => {
  await esbuild.build({
    entryPoints: [path.join(out, 'entry.jsx')],
    bundle: true,
    outdir: out,
    loader: { '.js': 'jsx', '.svg': 'dataurl', '.wav': 'file' },
    nodePaths: [path.join(process.cwd(), 'node_modules')],
    alias: { '@twilio/voice-sdk': path.join(out, 'sdk.js') },
    define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.PUBLIC_URL': '""',
    },
  });
  fs.writeFileSync(
    path.join(out, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script>${bridge}</script><script src="entry.js"></script></body></html>`,
  );
  http
    .createServer((req, res) => {
      const p = path.join(
        out,
        req.url === '/' ? 'index.html' : path.basename(req.url),
      );
      if (!fs.existsSync(p)) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader(
        'Content-Type',
        p.endsWith('.js')
          ? 'text/javascript'
          : p.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      );
      fs.createReadStream(p).pipe(res);
    })
    .listen(port, '127.0.0.1', () =>
      console.log(
        'Fictional local-only UI fixture at http://127.0.0.1:' + port,
      ),
    );
})();
