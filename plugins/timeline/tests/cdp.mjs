import { once } from 'node:events'
export async function connect(port, filter = () => true) {
 const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
 const target = targets.find(filter)
 if (!target) throw new Error('no target '+JSON.stringify(targets))
 const ws = new WebSocket(target.webSocketDebuggerUrl)
 await once(ws,'open')
 let seq=0; const pending=new Map()
 const settle=(id,error,value)=>{const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timer);error?p.reject(error):p.resolve(value)}
 ws.addEventListener('message', ev=> { const m=JSON.parse(ev.data);settle(m.id,m.error?new Error(JSON.stringify(m.error)):undefined,m.result) })
 ws.addEventListener('close',()=>{for(const id of pending.keys())settle(id,new Error('Debug connection closed'))})
 const send=(method,params={})=>new Promise((resolve,reject)=>{ const id=++seq;const timer=setTimeout(()=>settle(id,new Error('Debug request timed out: '+method)),30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params})) })
 const evaluate=async(expression)=>{ const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
 return {send,evaluate,close:()=>ws.close()}
}
