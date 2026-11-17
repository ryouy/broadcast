import { XMLParser } from "fast-xml-parser";
import { compose, githubSignatureValid, normalizeText, sourceKey } from "./core";

interface Env {
 DB: D1Database;
 ADMIN_TOKEN?: string; GITHUB_WEBHOOK_SECRET?: string;
 X_USER_ACCESS_TOKEN?: string; INSTAGRAM_ACCESS_TOKEN?: string; INSTAGRAM_USER_ID?: string;
}
type Source={id:string;type:"github"|"rss";name:string;url:string;enabled:number;post_x:number;post_instagram:number;default_image_url:string|null;etag:string|null;last_modified:string|null;initialized:number};
type Delivery={id:string;event_id:string;platform:"x"|"instagram";text:string;image_url:string|null;attempts:number;status:string};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const error=(message:string,status=400)=>json({error:message},status);
const uid=()=>crypto.randomUUID();
const text=(input:unknown,max=500)=>normalizeText(String(input??""),max);
const httpUrl=(value:string)=>{try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!["localhost","127.0.0.1","::1"].includes(u.hostname)&&!u.hostname.endsWith(".local")&& !u.hostname.endsWith(".internal");}catch{return false;}};
const safeId=(s:string)=>/^[a-zA-Z0-9_-]{1,70}$/.test(s);
const ACCESS_HEADERS={"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
function githubRepo(url:string){try{const u=new URL(url);const parts=u.pathname.split("/").filter(Boolean);return u.hostname==="github.com"&&parts.length===2&&parts.every(s=>/^[\w.-]+$/.test(s))?parts.join("/"):null;}catch{return null;}}
async function enqueue(env:Env,source:Source,externalId:string,title:string,description:string,url:string,image?:string|null){
 if(!httpUrl(url))return;
 const eid=uid();
 const inserted=await env.DB.prepare("INSERT OR IGNORE INTO events(id,source_id,external_id,title,description,url,image_url) VALUES(?,?,?,?,?,?,?)").bind(eid,source.id,externalId,text(title,200),text(description,1000),url,image||null).run();
 if(!inserted.meta.changes)return;
 for(const platform of ["x","instagram"] as const){
  if(platform==="x"&&!source.post_x||platform==="instagram"&&!source.post_instagram)continue;
  const picture=image&&httpUrl(image)?image:source.default_image_url;
  await env.DB.prepare("INSERT OR IGNORE INTO deliveries(id,event_id,platform,text,image_url) VALUES(?,?,?,?,?)").bind(uid(),eid,platform,compose(title,description,url,platform),picture||null).run();
 }
}
async function webhook(req:Request,env:Env){
 const secret=env.GITHUB_WEBHOOK_SECRET;
 if(!secret)return error("Webhook is not configured",503);
 const raw=await req.text();
 if(raw.length>256_000)return error("Payload too large",413);
 if(!await githubSignatureValid(raw,req.headers.get("x-hub-signature-256"),secret))return error("Invalid signature",401);
 const event=req.headers.get("x-github-event");
 if(event==="ping")return json({ok:true});
 if(event!=="release")return json({ignored:event});
 let data:any;try{data=JSON.parse(raw);}catch{return error("Invalid JSON");}
 if(data.action!=="published"||!data.release||!data.repository?.full_name)return json({ignored:true});
 const repo=String(data.repository.full_name);
 const source=await env.DB.prepare("SELECT * FROM sources WHERE type='github' AND url=? AND enabled=1").bind("https://github.com/"+repo).first<Source>();
 if(!source)return json({ignored:"no matching source"});
 await enqueue(env,source,String(data.release.id),data.release.name||data.release.tag_name||repo,data.release.body||"",data.release.html_url||"https://github.com/"+repo,data.release.image_url||null);
 return json({ok:true});
}
function entries(raw:any):any[]{if(Array.isArray(raw))return raw;return raw?[raw]:[];}
function linkOf(item:any):string{if(typeof item.link==="string")return item.link;const links=entries(item.link);return String(links.find(x=>x?.["@_rel"]==="alternate")?.["@_href"]||links[0]?.["@_href"]||"");}
async function pollFeed(env:Env,source:Source){
 const headers:Record<string,string>={"user-agent":"Broadcast/0.1 (+personal feed reader)","accept":"application/rss+xml, application/atom+xml, application/xml, text/xml"};
 if(source.etag)headers["if-none-match"]=source.etag;
 if(source.last_modified)headers["if-modified-since"]=source.last_modified;
 const response=await fetch(source.url,{headers,redirect:"error",signal:AbortSignal.timeout(10000)});
 if(response.status===304)return;
 if(!response.ok)throw Error("RSS HTTP "+response.status);
 const xml=await response.text();if(xml.length>1_000_000)throw Error("Feed too large");
 const parsed=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false}).parse(xml);
 const items=entries(parsed.rss?.channel?.item||parsed.feed?.entry).slice(0,40);
 for(const item of items.reverse()){
  const url=linkOf(item);if(!httpUrl(url))continue;
  const key=String(item.guid?.["#text"]||item.guid||item.id||url);
  if(!source.initialized)continue; // First sync does not post existing articles
  const description=String(item.description||item.summary||item.content?.["#text"]||"");
  await enqueue(env,source,key,String(item.title?.["#text"]||item.title||"Untitled"),description,url,null);
 }
 await env.DB.prepare("UPDATE sources SET initialized=1,etag=?,last_modified=? WHERE id=?").bind(response.headers.get("etag"),response.headers.get("last-modified"),source.id).run();
}
async function poll(env:Env){
 const sources=await env.DB.prepare("SELECT * FROM sources WHERE enabled=1 LIMIT 30").all<Source>();
 for(const source of sources.results){
  try{
   if(!httpUrl(source.url))continue;
   if(source.type==="rss")await pollFeed(env,source);
   else if(source.type==="github")await pollGitHub(env,source);
  }catch(e){console.error("Source poll failed",source.id,String(e));}
 }
}
// Public GitHub Releases API fallback: works without repository webhook admin rights.
async function pollGitHub(env:Env,source:Source) {
 const repo=githubRepo(source.url);if(!repo)return;
 const resp=await fetch("https://api.github.com/repos/"+repo+"/releases?per_page=10",{
  headers:{"accept":"application/vnd.github+json","user-agent":"broadcast-release-monitor"},
  signal:AbortSignal.timeout(10000)
 });
 if(!resp.ok)throw Error("GitHub releases HTTP "+resp.status);
 const releases:any=await resp.json();
 if(!Array.isArray(releases))throw Error("Invalid releases payload");
 for(const release of releases.slice().reverse()){
  if(release.draft||release.prerelease||!release.published_at||!release.id)continue;
  await enqueue(env,source,String(release.id),String(release.name||release.tag_name||repo),
   String(release.body||""),String(release.html_url||"https://github.com/"+repo+"/releases"),null);
 }
}
async function publishX(env:Env,d:Delivery){
 if(!env.X_USER_ACCESS_TOKEN)throw Error("Missing X_USER_ACCESS_TOKEN");
 if(d.image_url)throw Error("X image upload is not enabled yet; remove image or implement media upload");
 const res=await fetch("https://api.x.com/2/tweets",{method:"POST",headers:{"authorization":"Bearer "+env.X_USER_ACCESS_TOKEN,"content-type":"application/json"},body:JSON.stringify({text:d.text})});
 const body:any=await res.json().catch(()=>({}));
 if(!res.ok)throw Error("X HTTP "+res.status+" "+JSON.stringify(body).slice(0,250));
 if(!body.data?.id)throw Error("X returned no post ID");
 return {id:String(body.data.id),url:"https://x.com/i/web/status/"+body.data.id};
}
async function publishInstagram(env:Env,d:Delivery){
 if(!env.INSTAGRAM_ACCESS_TOKEN||!env.INSTAGRAM_USER_ID)throw Error("Missing Instagram credentials");
 if(!d.image_url||!httpUrl(d.image_url))throw Error("Instagram requires a public HTTPS image URL");
 const api="https://graph.instagram.com/v24.0/"+encodeURIComponent(env.INSTAGRAM_USER_ID);
 const auth="Bearer "+env.INSTAGRAM_ACCESS_TOKEN;
 const create=await fetch(api+"/media",{method:"POST",headers:{"authorization":auth,"content-type":"application/json"},body:JSON.stringify({image_url:d.image_url,caption:d.text})});
 const c:any=await create.json().catch(()=>({}));
 if(!create.ok||!c.id)throw Error("Instagram container HTTP "+create.status+" "+JSON.stringify(c).slice(0,250));
 // Graph may need time to process the container; never auto-retry an ambiguous publish.
 const post=await fetch(api+"/media_publish",{method:"POST",headers:{"authorization":auth,"content-type":"application/json"},body:JSON.stringify({creation_id:c.id})});
 const p:any=await post.json().catch(()=>({}));
 if(!post.ok||!p.id)throw Error("Instagram publish HTTP "+post.status+" "+JSON.stringify(p).slice(0,250));
 return {id:String(p.id),url:null};
}
async function dispatch(env:Env){
 const due=await env.DB.prepare("SELECT * FROM deliveries WHERE status='scheduled' AND scheduled_at <= datetime('now') ORDER BY scheduled_at LIMIT 5").all<Delivery>();
 for(const d of due.results){
  const claimed=await env.DB.prepare("UPDATE deliveries SET status='processing', claimed_at=CURRENT_TIMESTAMP, attempts=attempts+1 WHERE id=? AND status='scheduled'").bind(d.id).run();
  if(!claimed.meta.changes)continue;
  try{
   const result=d.platform==="x"?await publishX(env,d):await publishInstagram(env,d);
   await env.DB.prepare("UPDATE deliveries SET status='published',remote_id=?,remote_url=?,published_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?").bind(result.id,result.url,d.id).run();
  }catch(e){
   // Avoid unsafe retries: the remote operation may have succeeded despite timeout.
   await env.DB.prepare("UPDATE deliveries SET status='unknown',last_error=? WHERE id=?").bind(String(e).slice(0,500),d.id).run();
   console.error("Delivery requires review",d.id,String(e));
  }
 }
}
async function admin(req:Request,env:Env,url:URL){
 if(!env.ADMIN_TOKEN)return error("ADMIN_TOKEN not configured",503);
 const h=req.headers.get("authorization")||"";
 if(h!=="Bearer "+env.ADMIN_TOKEN)return error("Unauthorized",401);
 if(req.method==="POST"&&url.pathname==="/api/check"){await poll(env);return json({ok:true});}
 if(req.method==="GET"&&url.pathname==="/api/status"){
  const counts=await env.DB.prepare("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status").all();
  return json({ok:true,counts:counts.results});
 }
 if(req.method==="GET"&&url.pathname==="/api/sources")return json((await env.DB.prepare("SELECT * FROM sources ORDER BY created_at DESC").all()).results);
 if(req.method==="GET"&&url.pathname==="/api/deliveries")return json((await env.DB.prepare("SELECT d.*,e.title,e.url AS source_url,s.name AS source_name FROM deliveries d JOIN events e ON e.id=d.event_id JOIN sources s ON s.id=e.source_id ORDER BY d.created_at DESC LIMIT 100").all()).results);
 if(req.method==="POST"&&url.pathname==="/api/sources"){
  const body:any=await req.json().catch(()=>null);if(!body)return error("Invalid JSON");
  const type=body.type;
  const name=text(body.name,100),address=String(body.url||"").replace(/\/$/,"");
  if(!["github","rss"].includes(type)||!name||!httpUrl(address))return error("Invalid source");
  if(type==="github"&&!githubRepo(address))return error("GitHub URL must be https://github.com/owner/repo");
  if(type==="rss"&&new URL(address).hostname==="github.com")return error("Invalid RSS hostname");
  const id=uid();
  const image=body.default_image_url?String(body.default_image_url):null;
  if(image&&!httpUrl(image))return error("Invalid image URL");
  await env.DB.prepare("INSERT INTO sources(id,type,name,url,post_x,post_instagram,default_image_url) VALUES(?,?,?,?,?,?,?)").bind(id,type,name,address,body.post_x===false?0:1,body.post_instagram===true?1:0,image).run();
  return json({id},201);
 }
 const match=url.pathname.match(/^\/api\/deliveries\/([\w-]+)\/(approve|skip)$/);
 if(req.method==="POST"&&match){
  const [ ,id,action]=match;
  if(!safeId(id))return error("Invalid ID");
  const result=await env.DB.prepare(action==="approve"?"UPDATE deliveries SET status='scheduled',scheduled_at=datetime('now') WHERE id=? AND status='pending_review'":"UPDATE deliveries SET status='skipped' WHERE id=? AND status IN ('pending_review','scheduled')").bind(id).run();
  return json({updated:result.meta.changes});
 }
 return error("Not found",404);
}
const page=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Broadcast</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#202124;max-width:960px;margin:48px auto;padding:0 18px}h1{font-weight:650;letter-spacing:-1px}input,select,button{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px}button{cursor:pointer;background:#fff}button:hover{background:#eee}.panel{background:white;border:1px solid #ddd;padding:22px;border-radius:16px;margin:18px 0}label{display:block;font-size:13px;margin:12px 0 5px;color:#555}input[type=text],input[type=password],input[type=url]{width:min(100%,500px);box-sizing:border-box}.entry{padding:15px 0;border-bottom:1px solid #eee}.muted{color:#777;font-size:13px}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}#message{white-space:pre-wrap;color:#9b2e24}</style>
<h1>Broadcast</h1><p class="muted">GitHub と RSS の更新を検知して投稿を管理します。公開前に承認が必要です。</p>
<section class="panel"><label>管理トークン（このタブ内でのみ保持します）</label><input id="token" type="password" autocomplete="off" placeholder="ADMIN_TOKEN"><button id="load">読み込む</button><p id="message"></p></section>
<section class="panel"><h2>監視ソースを追加</h2><form id="newSource"><label>種類</label><select id="kind"><option value="github">GitHub Releases</option><option value="rss">RSS / Atom</option></select><label>名前</label><input id="name" type="text" required placeholder="My project"><label>URL</label><input id="url" type="url" required placeholder="https://github.com/owner/repo"><label>Instagram用公開画像URL（任意）</label><input id="image" type="url" placeholder="https://example.com/image.jpg"><p class="row"><label><input id="x" type="checkbox" checked> X</label><label><input id="ig" type="checkbox"> Instagram</label></p><button type="submit">追加する</button></form></section>
<section class="panel"><h2>監視ソース</h2><div id="sources" class="muted">未読み込み</div></section>
<section class="panel"><h2>投稿キュー</h2><div id="deliveries" class="muted">未読み込み</div></section>
<script>
const $=id=>document.getElementById(id);
let token="";
function node(tag,text){const el=document.createElement(tag);el.textContent=String(text??"");return el}
async function api(path,init={}){const r=await fetch(path,{...init,headers:{"authorization":"Bearer "+token,...init.headers}});const j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j}
async function load(){
try{const [sources,items]=await Promise.all([api("/api/sources"),api("/api/deliveries")]);$("message").textContent="";
$("sources").replaceChildren(...sources.map(s=>{const div=node("div",s.name+" — "+s.type+" — "+s.url);div.className="entry";return div}));
$("deliveries").replaceChildren(...items.map(d=>{const div=document.createElement("div");div.className="entry";div.append(node("strong",d.title+" ["+d.platform+"] "),node("span"," — "+d.status));div.append(node("p",d.text));if(d.last_error)div.append(node("p",d.last_error));if(d.status==="pending_review"){for(const action of ["approve","skip"]){const b=node("button",action==="approve"?"承認":"スキップ");b.onclick=async()=>{try{await api("/api/deliveries/"+d.id+"/"+action,{method:"POST"});await load()}catch(e){$("message").textContent=String(e)}};div.append(b)}}return div}));
}catch(e){$("message").textContent=String(e)}
}
$("load").onclick=()=>{token=$("token").value;load()};
$("newSource").onsubmit=async ev=>{ev.preventDefault();try{await api("/api/sources",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:$("kind").value,name:$("name").value,url:$("url").value,default_image_url:$("image").value||null,post_x:$("x").checked,post_instagram:$("ig").checked})});$("newSource").reset();await load()}catch(e){$("message").textContent=String(e)}};
</script></html>`;
export default {
 async fetch(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url);
  try{
   if(req.method==="GET"&&url.pathname==="/")return new Response(page,{headers:ACCESS_HEADERS});
   if(req.method==="POST"&&url.pathname==="/webhooks/github")return webhook(req,env);
   if(url.pathname.startsWith("/api/"))return admin(req,env,url);
   return error("Not found",404);
  }catch(e){console.error("Request failed",String(e));return error("Internal error",500);}
 },
 async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext){
  ctx.waitUntil((async()=>{await poll(env);await dispatch(env);})());
 }
};
