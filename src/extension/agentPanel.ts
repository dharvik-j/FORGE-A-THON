import * as vscode from 'vscode';
import { nonce } from './html';

export type PanelMessage = Record<string, unknown> & { type: string };

/** Sidebar view: conversation, live stream, tool activity, retrieved context, run state and cancel. */
export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'forge.agentView';
  private view: vscode.WebviewView | undefined;
  private backlog: PanelMessage[] = [];
  onSend: ((text: string) => void) | undefined;
  onCancel: (() => void) | undefined;
  onCommand: ((cmd: string, arg?: string) => void) | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((m: { type: string; text?: string; cmd?: string; arg?: string }) => {
      if (m.type === 'ready') {
        for (const b of this.backlog) void view.webview.postMessage(b);
      } else if (m.type === 'send' && m.text) this.onSend?.(m.text);
      else if (m.type === 'cancel') this.onCancel?.();
      else if (m.type === 'cmd' && m.cmd) this.onCommand?.(m.cmd, m.arg);
    });
  }

  post(msg: PanelMessage): void {
    this.backlog.push(msg);
    if (this.backlog.length > 2000) this.backlog.splice(0, this.backlog.length - 2000);
    void this.view?.webview.postMessage(msg);
  }

  clear(): void {
    this.backlog = this.backlog.filter(m => m.type === 'status');
    void this.view?.webview.postMessage({ type: 'clear' });
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
  }

  private html(): string {
    const n = nonce();
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">${PANEL_CSS}</style></head><body>
<div id="status" class="status"><span id="conn" class="dot"></span><span id="statusText">Connecting to TrueForge…</span></div>
<div id="log" class="log"><div class="empty">Describe a change. FORGE finds the relevant files itself; use <code>@path/file.py</code> or <code>@symbol:name</code> to pin context.</div></div>
<div id="run" class="run hidden"><span id="phase">Running</span><span id="meta"></span><button id="cancel" class="danger">Cancel</button></div>
<form id="f" class="composer"><textarea id="t" rows="3" placeholder="Ask FORGE to change the code… (Enter to send, Shift+Enter for a new line)"></textarea>
<div class="row"><button type="button" id="session" class="link">Open TrueForge session</button><button type="button" id="undo" class="link">Undo last apply</button><button type="submit" id="send" class="primary">Send</button></div></form>
<script nonce="${n}">${PANEL_JS}</script></body></html>`;
  }
}

const PANEL_CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0;margin:0;display:flex;flex-direction:column;height:100vh}
.status{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);font-size:11px;opacity:.9}
.dot{width:8px;height:8px;border-radius:50%;background:var(--vscode-disabledForeground);flex:none}.dot.ok{background:var(--vscode-testing-iconPassed)}.dot.bad{background:var(--vscode-testing-iconFailed)}
.log{flex:1;overflow-y:auto;padding:8px 10px}.empty{opacity:.7;line-height:1.5}
.msg{margin:8px 0;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}.msg.user{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:6px 8px}
.msg.agent{}.msg.sub{border-left:2px solid var(--vscode-textLink-foreground);padding-left:8px;opacity:.9}
.card{border:1px solid var(--vscode-panel-border);border-radius:4px;margin:8px 0;font-size:12px;overflow:hidden}
.card>header{display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--vscode-sideBarSectionHeader-background);cursor:pointer}
.card>header .k{font-weight:600}.card>header .d{opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.card .body{display:none;padding:6px 8px;white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:11px;max-height:260px;overflow:auto;border-top:1px solid var(--vscode-panel-border)}
.card.open .body{display:block}.card.err>header{color:var(--vscode-errorForeground)}
.ctx{border-color:var(--vscode-textLink-foreground)}.ctx .files{padding:6px 8px;display:block}.ctx .file{margin:4px 0}.ctx .p{font-family:var(--vscode-editor-font-family);font-weight:600}.ctx .r{opacity:.8}
.badge{font-size:10px;padding:0 5px;border-radius:7px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.phase{margin:8px 0;font-size:12px;padding:5px 8px;border-radius:3px;background:var(--vscode-textBlockQuote-background)}
.phase.error{color:var(--vscode-errorForeground)}.phase.fallback{border-left:3px solid var(--vscode-editorWarning-foreground)}.phase.done{border-left:3px solid var(--vscode-testing-iconPassed)}.phase.cancelled{border-left:3px solid var(--vscode-disabledForeground)}
.run{display:flex;gap:8px;align-items:center;padding:6px 10px;border-top:1px solid var(--vscode-panel-border);font-size:12px}.run.hidden{display:none}#meta{opacity:.7;flex:1}
#phase::before{content:'';display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background:var(--vscode-progressBar-background);animation:p 1s infinite alternate}@keyframes p{from{opacity:.25}to{opacity:1}}
.composer{border-top:1px solid var(--vscode-panel-border);padding:8px 10px}
textarea{width:100%;box-sizing:border-box;resize:vertical;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:6px}
textarea:focus{outline:1px solid var(--vscode-focusBorder)}
.row{display:flex;gap:6px;align-items:center;margin-top:6px}.row .primary{margin-left:auto}
button{font:inherit;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.danger{color:var(--vscode-button-foreground);background:var(--vscode-statusBarItem-errorBackground,#c4314b)}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:2px 0;margin-right:8px}button:disabled{opacity:.5;cursor:default}
code{font-family:var(--vscode-editor-font-family)}
`;

const PANEL_JS = `
const vs=acquireVsCodeApi();const log=document.getElementById('log');const t=document.getElementById('t');
const runBar=document.getElementById('run');const phaseEl=document.getElementById('phase');const meta=document.getElementById('meta');
const texts=new Map();const tools=new Map();let running=false;
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;}
function add(e){const empty=log.querySelector('.empty');if(empty)empty.remove();const stick=log.scrollHeight-log.scrollTop-log.clientHeight<40;log.appendChild(e);if(stick)log.scrollTop=log.scrollHeight;}
function card(kind,title,detail,body,cls){const c=el('div','card '+(cls||''));const h=el('header');h.appendChild(el('span','k',kind));h.appendChild(el('span','d',detail||''));c.appendChild(h);const b=el('div','body',body||'');c.appendChild(b);h.onclick=()=>c.classList.toggle('open');return c;}
function setRunning(r,label){running=r;runBar.classList.toggle('hidden',!r);document.getElementById('send').disabled=r;if(label)phaseEl.textContent=label;}
function short(o){try{const s=JSON.stringify(o);return s.length>140?s.slice(0,140)+'…':s;}catch{return ''}}
window.addEventListener('message',({data:m})=>{switch(m.type){
case 'clear':log.innerHTML='';texts.clear();tools.clear();break;
case 'status':{const c=document.getElementById('conn');c.className='dot '+(m.ok?'ok':'bad');document.getElementById('statusText').textContent=m.text;break;}
case 'user':add(el('div','msg user',m.text));break;
case 'phase':{
 const labels={starting:'Starting',running:'Running',review:'Waiting for your review',fallback:'Switching to fallback model'};
 if(['done','error','cancelled','fallback'].includes(m.phase)){add(el('div','phase '+m.phase,(m.phase==='done'?'✓ Completed':m.phase==='error'?'✗ Failed':m.phase==='cancelled'?'■ Cancelled':'⟳ Fallback')+(m.detail?': '+m.detail:'')));}
 if(m.phase==='done'||m.phase==='error'||m.phase==='cancelled')setRunning(false);else setRunning(true,labels[m.phase]||m.phase);
 break;}
case 'attempt':meta.textContent=(m.fallback?'fallback · ':'')+m.agent;add(card(m.fallback?'Fallback session':'TrueForge session',m.agent,m.sessionId,m.sessionUrl));break;
case 'text':{let e=texts.get(m.id);if(!e){e=el('div','msg '+(m.threadId==='main'?'agent':'sub'));texts.set(m.id,e);add(e);}e.textContent=(m.threadId!=='main'?'['+(m.threadTitle||'subagent')+'] ':'')+m.text;const stick=log.scrollHeight-log.scrollTop-log.clientHeight<80;if(stick)log.scrollTop=log.scrollHeight;break;}
case 'tool':{const c=card((m.threadId!=='main'?'↳ ':'')+'⚙ '+m.name,'',short(m.args),JSON.stringify(m.args,null,2));tools.set(m.id,c);add(c);break;}
case 'toolResult':{const c=tools.get(m.toolCallId);if(c){c.querySelector('.body').textContent+= '\\n\\n— result —\\n'+m.content;if(m.isError)c.classList.add('err');c.querySelector('.d').textContent=(m.isError?'error · ':'done · ')+c.querySelector('.d').textContent;}break;}
case 'thread':add(el('div','phase',(m.status==='created'?'⑂ Subagent started: ':m.status==='error'?'⑂ Subagent failed: ':'⑂ Subagent finished: ')+m.title+(m.input?'\\n'+m.input.slice(0,300):'')));break;
case 'context':{const c=el('div','card ctx open');const h=el('header');h.appendChild(el('span','k','CONTEXT RETRIEVAL'));h.appendChild(el('span','d',m.selected.length+' of '+m.candidates+' candidates · ~'+m.usedTokens+'/'+m.budgetTokens+' tokens'));c.appendChild(h);
 const files=el('div','files');for(const f of m.selected){const d=el('div','file');d.appendChild(el('span','p',f.path+' '));d.appendChild(el('span','badge',f.category));d.appendChild(el('div','r',f.reason));d.appendChild(el('div','r','lines '+f.ranges.map(r=>r.start+'-'+r.end).join(', ')+' · ~'+f.tokens+' tokens'));files.appendChild(d);}
 c.appendChild(files);h.onclick=()=>c.classList.toggle('open');add(c);break;}
case 'note':add(el('div','phase',m.text));break;
case 'metrics':meta.textContent=(meta.textContent.split(' · tokens')[0])+(m.totalTokens?' · tokens '+m.totalTokens:'')+(m.costUsd!=null?' · $'+Number(m.costUsd).toFixed(4):'');break;
}});
const form=document.getElementById('f');
form.addEventListener('submit',e=>{e.preventDefault();const v=t.value.trim();if(!v||running)return;vs.postMessage({type:'send',text:v});t.value='';});
t.addEventListener('keydown',e=>{if(e.key!=='Enter'||e.shiftKey||e.isComposing||e.keyCode===229)return;e.preventDefault();form.requestSubmit();});
document.getElementById('cancel').onclick=()=>vs.postMessage({type:'cancel'});
document.getElementById('session').onclick=()=>vs.postMessage({type:'cmd',cmd:'forge.openSession'});
document.getElementById('undo').onclick=()=>vs.postMessage({type:'cmd',cmd:'forge.undoLastApply'});
vs.postMessage({type:'ready'});
`;
