import {errorMessage} from '../errors.ts';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tokenize,parseSource} from './frontend.ts';
import {loadSource} from './load.ts';

const keywords=new Set('module import use singleton identity domain resource fields field relationships relationship from action inputs input bindings bind key id preconditions requires require policies policy deny allow when approve by changes update set end create as observations observe through initial revision records record version application title eyebrow subtitle scope loading actor label name present description default adapter output view summary list format type like min max enum ownerField reference widget constant source'.split(' '));
const types=new Set(['string','integer','boolean']);
const entities:Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>entities[c]??c);
type Parsed=ReturnType<typeof parseSource>;

// Use the real lexer so strings, escapes and comments share the language's rules.
// Styling is lexical only, not a claim of semantic validity.
export function highlight(source:string,{quietIds=false}={}){
  const tokens=tokenize(source),out:string[]=[];let cursor=0,head=true,previous:string|number|undefined;
  const starts=new Set(),ends=new Set();
  if(quietIds){
    let statement:string|number='';
    tokens.forEach((t,i)=>{
      if(i===0||tokens[i-1]?.kind==='newline')statement=t.value;
      const id=tokens[i+1];
      if(typeof statement==='string'&&['bind','require','approve','set','create'].includes(statement)&&t.kind==='word'&&t.value==='id'&&(id?.kind==='word'||id?.kind==='string')&&(tokens[i+2]?.kind==='newline'||tokens[i+2]?.value==='as')){
        starts.add(t.start);ends.add(id.end);
      }
    });
  }
  const gap=(s:string)=>escape(s).replace(/#[^\n]*/g,c=>`<span class="comment">${c}</span>`);
  for(const [i,t] of tokens.entries()){
    if(t.end===t.start)continue;
    out.push(gap(source.slice(cursor,t.start)));
    if(starts.has(t.start))out.push('<span class="quiet-id">');
    let cls='';
    if(t.kind==='string')cls='string';
    else if(t.kind==='number')cls='number';
    else if(t.kind==='symbol'&&t.value!=='.')cls='operator';
    else if(t.kind==='word'){
      if(['true','false'].includes(t.value))cls='number';
      else if(['and','or','not'].includes(t.value))cls='operator';
      else if(types.has(t.value))cls='type';
      else if(keywords.has(t.value)&&(head||((typeof previous!=='string'||!['field','input','resource','records','record','bind','set'].includes(previous))&&previous!=='.'&&t.value!=='end')))cls='keyword';
      // Grouped rows may use keyword-looking identifiers (name/end/actor).
      const next=tokens[i+1]?.value;
      if(head&&typeof next==='string'&&['string','integer','boolean','like','from'].includes(next))cls='';
    }
    const text=escape(source.slice(t.start,t.end));
    out.push(cls?`<span class="${cls}">${text}</span>`:text);
    if(ends.has(t.end))out.push('</span>');
    cursor=t.end;head=t.kind==='newline';previous=t.value;
  }
  out.push(gap(source.slice(cursor)));return out.join('');
}

export function sourcePage(source:string,title='Domain source',{inline=false,fullHref='time-away-highlighted.html',parsedSections}:{
  inline?:boolean;fullHref?:string;parsedSections?:Parsed['sections'];
}={}){
  let sections:Parsed['sections'],diagnostic='',rendered:string;
   try{sections=parsedSections??parseSource(source,{filename:title}).sections;rendered=highlight(source);}
  catch(error){diagnostic=errorMessage(error);sections=[{kind:'raw',name:'Original source',line:1}];rendered=escape(source);}
  const lines=rendered.split('\n');if(lines.at(-1)==='')lines.pop();
  const groups:Record<string|number,string>={domain:'Resources',resource:'Resources',relationship:'Resources',relationships:'Resources',action:'Actions',initial:'Initial data',application:'Interface',raw:'Source'};
  const group=(s:Parsed['sections'][number]|undefined)=>s&&groups[s.kind];
  const code=(start,end)=>`<pre><code>${lines.slice(start-1,end).map((s,j)=>`<span class="line" id="L${start+j}"><a class="ln" href="#L${start+j}" aria-label="Line ${start+j}">${start+j}</a><span class="text">${s}</span></span>`).join('')}</code></pre>`;
  const nav=sections.map((s,i)=>`${i===0||group(s)!==group(sections[i-1])?`<h2>${group(s)}</h2>`:''}<a href="#L${s.line}">${escape(String(s.name))}</a>`).join('');
  // One uninterrupted code region: no source lines are folded or filtered.
  const chunks=`<div class="source-section">${code(1,lines.length)}</div>`;
  // Embed exact bytes as escaped text, never as executable script or rewritten code.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
:root{color-scheme:dark;--paper:#17212e;--ink:#e1e9f3;--muted:#a6b5c8;--rule:#35475c;--keyword:#d2b5ff;--type:#86dce8;--string:#bfdc9b;--number:#ffd39b}
${inline?`:root{--paper:var(--code-background,var(--card,#17212e));--ink:var(--foreground,#e1e9f3);--muted:var(--muted-foreground,#a6b5c8);--rule:var(--border,#35475c);--keyword:var(--chart-4,#d2b5ff);--type:var(--chart-2,#86dce8);--string:var(--chart-3,#bfdc9b);--number:var(--chart-5,#ffd39b)}body.inline{font-family:var(--font-sans,system-ui)}body.inline pre,body.inline code{font-family:var(--font-mono,monospace)}body.inline a{color:var(--primary,#b4d9ff)}body.inline .source-section{border-radius:var(--radius,4px)}body.inline .source-section pre{padding:16px 0}body.inline .operator{color:var(--info,#a5ccff)}body.inline .comment,body.inline .ln{color:var(--muted-foreground,#a6b5c8)}`:''}
*{box-sizing:border-box}body{margin:0;background:#101925;color:var(--ink);font:14px/1.5 system-ui,sans-serif}a{color:#b4d9ff}button,.download{font:inherit;color:var(--ink);background:none;border:1px solid var(--rule);border-radius:4px;padding:5px 9px;cursor:pointer;text-decoration:none}button:hover,.download:hover{background:#2c3d52}:focus-visible{outline:2px solid var(--type);outline-offset:3px}header{padding:12px 20px;border-bottom:1px solid var(--rule);display:flex;gap:16px;align-items:center;flex-wrap:wrap}header strong{font:600 15px ui-monospace,monospace}.tools{display:flex;gap:8px;flex-wrap:wrap}.reader{display:grid;grid-template-columns:210px minmax(0,1fr);max-width:1600px;margin:auto}nav{padding:18px 16px;position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto}nav h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:18px 0 7px}nav h2:first-child{margin-top:0}nav a{display:block;padding:4px 8px;border-left:1px solid var(--rule);text-decoration:none;font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}nav a:hover{border-color:var(--type);background:var(--paper)}main{min-width:0;padding:18px 20px 60px 0}.source-section{border:1px solid var(--rule);margin-bottom:16px;background:var(--paper);scroll-margin:12px}.source-section summary{cursor:pointer;padding:10px 14px;color:var(--ink)}summary strong{font:600 14px ui-monospace,monospace}summary small{display:block;margin-left:17px;color:var(--muted);font-size:12px}.source-section[open] summary{border-bottom:1px solid var(--rule)}pre{margin:0;padding:12px 0;overflow-x:auto;tab-size:2;font:13px/1.75 ui-monospace,SFMono-Regular,Consolas,monospace}code{font:inherit}.line{display:block;min-width:max-content;min-height:1.75em;padding-right:18px}.ln{display:inline-block;width:5ch;margin-right:18px;text-align:right;color:#a0b1c5;text-decoration:none;user-select:none}.line:target{background:#30435a}.keyword{color:var(--keyword)}.type{color:var(--type)}.string{color:var(--string)}.number{color:var(--number)}.operator{color:#a5ccff}.comment{color:#a6b5c8;font-style:italic}.quiet-id{opacity:.82}.focus-ids .quiet-id{display:none}.notice{color:var(--muted);font-size:12px;margin:0 0 12px}.diagnostic{color:#ffd39b}#original{max-width:100%;margin-top:20px}#original pre{white-space:pre;padding:12px;background:var(--paper)}[hidden]{display:none!important}#status{color:var(--muted);font-size:12px}body.inline{max-width:728px;background:transparent}body.inline header{display:none}body.inline .reader{display:block}body.inline nav{position:static;max-height:none;display:flex;gap:8px;flex-wrap:wrap;padding:0 0 12px}body.inline nav h2{width:100%;margin:8px 0 0}body.inline main{padding:0}body.inline .source-section{margin-bottom:12px}@media(max-width:800px){.reader{display:block}nav{position:static;max-height:none;display:flex;flex-wrap:wrap;gap:4px 10px;padding:12px}nav h2{width:100%;margin:8px 0 0}nav a{padding:2px 6px}main{padding:0 12px 30px}header{padding:12px}.ln{margin-right:12px}summary small{font-size:11px}}@media(prefers-reduced-motion:no-preference){.source-section:target{border-color:var(--type)}}
</style><body${inline?' class="inline"':''}><header><strong>${escape(title)}</strong><span class="notice">Source reader · experimental .domain</span></header><div class="reader"><nav aria-label="Source outline">${nav}</nav><main><div class="tools"><button id="raw">Original source</button><button id="copy">Copy source</button><a class="download" download="source.domain" id="download">Download .domain</a>${inline?`<a class="download" href="${escape(fullHref)}">Full source reader</a>`:''}</div><p class="notice">Whole file · all lines and IDs visible. Highlighting is not verification.</p><p id="status" role="status"></p>${diagnostic?`<p class="diagnostic">${escape(diagnostic)}</p>`:''}${chunks}<section id="original" hidden><h2>Original source · exact text</h2><pre id="raw-text">${escape(source)}</pre></section></main></div><script>
document.querySelector('#raw').onclick=()=>{const d=document.querySelector('#original');d.hidden=!d.hidden;if(!d.hidden)d.scrollIntoView()};
const source=document.querySelector('#raw-text').textContent;
document.querySelector('#download').href=URL.createObjectURL(new Blob([source],{type:'text/plain;charset=utf-8'}));
document.querySelector('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(source);document.querySelector('#status').textContent='Exact source copied.'}catch{document.querySelector('#original').hidden=false;document.querySelector('#status').textContent='Clipboard unavailable. Select original text or download the file.'}};
function reveal(){const id=decodeURIComponent(location.hash.slice(1));const target=document.getElementById(id);if(!target)return;let p=target;while(p){if(p.tagName==='DETAILS')p.open=true;p=p.parentElement}target.scrollIntoView()}
addEventListener('hashchange',reveal);reveal();
</script></body></html>`.replaceAll('max-height:100vh','max-height:900px');
}

export function moduleSourcePage(path:string|URL){
  const loaded=loadSource(path);
  const frames=loaded.modules.map(m=>`<h2>${escape(m.filename)}</h2><p>${escape(m.kind??'legacy')} · ${escape(m.id??'single file')}</p><iframe title="${escape(m.filename)}" srcdoc="${escape(sourcePage(m.source,m.filename,{parsedSections:loaded.sections.filter(s=>s.filename===m.filename)}))}"></iframe>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Source modules</title><style>body{background:#101925;color:#e1e9f3;font:14px system-ui;margin:24px}h2,p{overflow-wrap:anywhere}iframe{width:100%;height:750px;border:1px solid #35475c}</style><h1>Complete source import closure</h1><p>Entry: ${escape(loaded.entry)}. Every file below is complete, with exact-source copy/download. No author code is omitted.</p>${frames}</html>`;
}

// Compact static projection for inline chat; exact excerpts, not pseudocode.
export function sourceExcerptPage(source:string,{filename='leave/time-away.domain',ids=['settings','settings.change'],fullHref='time-away-highlighted.html',parsed}:{
  filename?:string;ids?:string[];fullHref?:string;parsed?:Pick<Parsed,'sourceMap'>;
}={}){
  const {sourceMap}=parsed??parseSource(source,{filename}),lines=highlight(source).split('\n');
  const excerpts=ids.map(id=>{
    const span=sourceMap[id];if(!span)throw Error(`Unknown excerpt ID '${id}'.`);
    return `<section><h2>${escape(id)} <small>L${span.start.line}–${span.end.line}</small></h2><pre><code>${lines.slice(span.start.line-1,span.end.line).map((text,i)=>`<span class="row"><span class="ln">${span.start.line+i}</span>${text}</span>`).join('')}</code></pre></section>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actual source excerpts</title><style>
body{margin:0;color:var(--foreground,#e1e9f3);font:14px/1.5 var(--font-sans,system-ui)}main{max-width:728px;min-width:0}p{margin:0 0 12px;color:var(--muted-foreground,#a6b5c8)}a{color:var(--primary,#a5ccff)}section{margin:0 0 16px}h2{font:600 14px var(--font-mono,monospace);margin:0 0 8px}small{font:12px var(--font-sans,system-ui);color:var(--muted-foreground,#a6b5c8)}pre{margin:0;padding:16px;background:var(--code-background,#17212e);border-radius:var(--radius,6px);overflow-x:auto;font:13px/1.8 var(--font-mono,monospace)}code{font:inherit}.row{display:block;min-width:max-content}.ln{display:inline-block;width:3ch;margin-right:16px;color:var(--muted-foreground,#a6b5c8);user-select:none}.keyword{color:var(--chart-4,#d2b5ff)}.type{color:var(--chart-2,#86dce8)}.string{color:var(--chart-3,#bfdc9b)}.number{color:var(--chart-5,#ffd39b)}.operator{color:var(--info,#a5ccff)}.comment{color:var(--muted-foreground,#a6b5c8)}
</style><main><p>Exact excerpts from <code>${escape(filename)}</code> · <a href="${escape(fullHref)}">Open full source reader</a></p>${excerpts}<p>Full reader shows every line and ID continuously, with an outline and exact original source. Highlighting is not verification.</p></main></html>`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);
  if(!input||!output)throw Error('Usage: node syntax/highlight.ts source.domain output.html');
  await writeFile(output,moduleSourcePage(input));
  console.log(resolve(output));
}
