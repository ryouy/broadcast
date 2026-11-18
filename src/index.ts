import { XMLParser } from "fast-xml-parser";
import { authMode, callback, login, logout, sameOrigin, session } from "./auth";
import { compose, githubSignatureValid, normalizeText, sourceKey } from "./core";

interface Env {
 DB: D1Database;
 GITHUB_WEBHOOK_SECRET?: string;
 GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; SESSION_SECRET?: string; ALLOWED_EMAILS?: string;
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
   if(!httpUrl(source.url))throw Error("Invalid source URL");
   if(source.type==="rss")await pollFeed(env,source);
   else if(source.type==="github")await pollGitHub(env,source);
   await env.DB.prepare("UPDATE sources SET last_checked_at=CURRENT_TIMESTAMP,last_check_error=NULL WHERE id=?").bind(source.id).run();
  }catch(e){
   const message=String(e).slice(0,400);
   console.error("Source poll failed",source.id,message);
   await env.DB.prepare("UPDATE sources SET last_checked_at=CURRENT_TIMESTAMP,last_check_error=? WHERE id=?").bind(message,source.id).run();
  }
 }
}
// Public GitHub Releases API fallback: works without repository webhook admin rights.
export async function pollGitHub(env:Env,source:Source) {
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
 const mode=authMode(env);
 if(mode!=="google")return error("Google OAuth configuration incomplete",503);
 if(!await session(req,env))return error("Unauthorized",401);
 if(req.method!=="GET"&&!sameOrigin(req))return error("Invalid request origin",403);
 if(req.method==="POST"&&url.pathname==="/api/check"){await poll(env);return json({ok:true});}
 if(req.method==="GET"&&url.pathname==="/api/status"){
  const counts=await env.DB.prepare("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status").all();
  const monitoring=await env.DB.prepare("SELECT last_cron_at,last_cron_error FROM monitoring_state WHERE id=1").first();
  return json({ok:true,counts:counts.results,monitoring});
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
const page=`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f8f8f6">
<title>Broadcast — Dashboard</title>
<style>
:root{color-scheme:light;--bg:#f8f8f6;--paper:#fff;--ink:#202320;--muted:#858883;--line:#e8e9e5;--soft:#f2f3f0;--accent:#2f5144;--error:#a13d36}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;-webkit-font-smoothing:antialiased}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
.shell{max-width:1440px;min-height:100vh;margin:auto;display:grid;grid-template-columns:230px minmax(0,1fr)}
.sidebar{padding:35px 22px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:50px}
.brand{display:flex;gap:11px;align-items:center;font-size:17px;font-weight:680;letter-spacing:-.7px;padding:1px 12px}
.brand-icon{height:27px;width:27px;display:grid;place-items:center;background:var(--ink);color:#fff;border-radius:9px;font-size:17px}
.nav{display:grid;gap:4px}.nav a{display:flex;gap:11px;align-items:center;padding:12px;border-radius:9px;color:#656a64;font-weight:520;font-size:13px}.nav a.active{background:#e9eee9;color:var(--accent)}.nav svg,.mini svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.side-bottom{display:none}
.content{padding:36px clamp(22px,5.5vw,78px) 70px;min-width:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:58px}.crumb{font-size:12px;color:var(--muted)}.top-actions{display:flex;align-items:center;gap:12px}.online{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#607967}.dot{height:7px;width:7px;border-radius:50%;background:#7da18b}
.icon-button{width:36px;height:36px;display:grid;place-items:center;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:#555b55}.icon-button svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.heading{display:flex;align-items:flex-end;justify-content:space-between;gap:15px;margin-bottom:34px}h1{font-size:clamp(30px,3.1vw,43px);font-weight:620;letter-spacing:-1.8px;line-height:1.1;margin:0 0 11px}.sub{color:var(--muted);font-size:13px;margin:0;line-height:1.6}
.primary{background:var(--ink);color:#fff;border:1px solid var(--ink);border-radius:10px;padding:11px 16px;font-size:12px;font-weight:600}.primary:hover{background:#363b35}.secondary{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:12px;font-weight:560;color:#474b46}.secondary:hover,.icon-button:hover{background:#f0f1ef}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:42px}.stat{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:21px 23px;min-height:116px}.stat-label{color:#777e77;font-size:12px;margin-bottom:20px}.stat strong{font-size:30px;font-weight:580;letter-spacing:-1.1px;line-height:1}
.section{margin-bottom:40px;scroll-margin-top:24px}.section-head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:0 0 16px}.section-head h2{font-size:17px;font-weight:630;letter-spacing:-.4px;margin:0}.section-meta{font-size:12px;color:var(--muted)}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.list-row{display:flex;gap:15px;align-items:center;padding:20px 22px;border-bottom:1px solid var(--line)}.list-row:last-child{border-bottom:0}
.source-icon{height:40px;width:40px;flex:0 0 40px;display:grid;place-items:center;border:1px solid var(--line);border-radius:11px;font-size:18px;font-weight:600;background:#fbfbfa}.source-icon svg{height:18px;width:18px}
.record{min-width:0;flex:1}.record-title{font-weight:600;font-size:13px;line-height:1.4;overflow-wrap:anywhere}.record-sub{color:var(--muted);font-size:12px;line-height:1.5;margin-top:4px;overflow-wrap:anywhere}.record-sub a{text-decoration:underline;text-decoration-color:#cbd0c9;text-underline-offset:3px}
.end{display:flex;align-items:center;gap:10px;flex-shrink:0}.pill{font-size:11px;color:#68756e;border:1px solid #e2e9e3;background:#f2f6f2;padding:6px 9px;border-radius:99px;white-space:nowrap}.pill.awaiting{background:#faf8ee;border-color:#eee9d2;color:#827648}.pill.failed{background:#fbf1f0;border-color:#f0dfdc;color:#a15549}.pill.muted{background:#f5f5f4;border-color:#ececea;color:#898c87}
.platform{height:25px;width:25px;display:grid;place-items:center;border:1px solid var(--line);border-radius:7px;font-size:12px;font-weight:650}
.delivery{padding:20px 22px;border-bottom:1px solid var(--line)}.delivery:last-child{border-bottom:0}.delivery-top{display:flex;align-items:flex-start;gap:12px}.delivery-actions{margin:14px 0 0 37px;display:flex;gap:8px;flex-wrap:wrap}.delivery-copy{font-size:12px;white-space:pre-wrap;color:#656a64;line-height:1.7;margin:9px 0 0;max-width:630px;overflow-wrap:anywhere}.error-note{color:var(--error)}
.empty{padding:42px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.8}.empty strong{display:block;color:var(--ink);font-size:14px;margin-bottom:5px}
.settings{display:grid;grid-template-columns:1fr 1fr;gap:13px;padding:21px 22px}.field{display:grid;gap:7px;min-width:0}.field.full{grid-column:1/-1}.field label{font-size:11px;color:#70766f;font-weight:600}.field input,.field select{height:43px;width:100%;border:1px solid #e4e6e2;background:#fff;border-radius:9px;padding:10px 12px;min-width:0;color:var(--ink);outline:none}.field input:focus,.field select:focus{border-color:#869f8d;box-shadow:0 0 0 3px #eff3ee}
.form-bottom{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:7px;flex-wrap:wrap}.checks{display:flex;gap:18px;align-items:center}.checks label{display:flex;align-items:center;gap:7px;color:#666d66;font-size:12px}.checks input{accent-color:var(--accent)}
#notice{min-height:20px;margin:0 0 20px;color:#697c6d;font-size:12px;line-height:1.6}#notice.error{color:var(--error)}
.lock{position:fixed;inset:0;z-index:9;background:#f8f8f6f7;display:flex;align-items:center;justify-content:center;padding:20px}.lock.hidden{display:none}.login{width:min(100%,408px);background:white;border:1px solid var(--line);border-radius:19px;padding:38px;box-shadow:0 12px 45px #2023200a}.login h2{margin:25px 0 9px;font-size:27px;letter-spacing:-1px;font-weight:630}.login p{font-size:13px;line-height:1.7;color:var(--muted);margin:0 0 24px}.login .primary{height:44px;width:100%;margin-top:13px}.login .field input{height:47px}.login #login-message{min-height:18px;font-size:12px;line-height:1.6;margin:13px 0 0;color:var(--error)}.login .brand{padding:0}
.footer{margin:36px 0 0;color:#a4a7a1;font-size:11px;display:flex;justify-content:space-between;gap:12px}
@media(max-width:900px){.shell{grid-template-columns:1fr}.sidebar{padding:16px 20px;border-right:0;border-bottom:1px solid var(--line);display:flex;flex-direction:row;align-items:center;gap:12px}.brand{padding:0}.nav{display:flex;gap:4px;margin-left:auto}.nav a{font-size:12px;padding:10px}.side-bottom{display:none}.content{padding:25px 20px 55px}.top{margin-bottom:36px}}
@media(max-width:620px){.nav a span{display:none}.nav a{padding:9px}.top{margin-bottom:32px}.heading{align-items:flex-start;flex-direction:column}.stats{gap:8px;margin-bottom:30px}.stat{padding:16px 14px;min-height:96px}.stat-label{font-size:11px;margin-bottom:17px}.stat strong{font-size:26px}.list-row,.delivery{padding:17px 15px}.section{margin-bottom:30px}.settings{padding:17px 15px;grid-template-columns:1fr}.field.full{grid-column:auto}.delivery-actions{margin-left:0}.end{gap:5px}.pill{font-size:10px}.online{font-size:11px}.footer{flex-direction:column}.login{padding:28px}}
@media(prefers-reduced-motion:no-preference){button,.nav a{transition:background .16s,color .16s}}

/* Desktop: one viewport, zero page or panel scrolling. */
@media (min-width:901px){
 html,body{width:100%;height:100%;overflow:hidden}
 .shell{height:100dvh;min-height:0;overflow:hidden;grid-template-columns:205px minmax(0,1fr)}
 .sidebar{padding:24px 16px;gap:30px;min-height:0}
 .content{padding:22px clamp(18px,3vw,42px) 16px;height:100dvh;min-height:0;overflow:hidden;display:flex;flex-direction:column}
 .top{margin-bottom:18px;flex-shrink:0}
 .heading{margin-bottom:12px;flex-shrink:0}
 h1{font-size:clamp(27px,2.3vw,35px);margin-bottom:5px}
 .sub{font-size:12px}
 #notice{margin:0 0 10px;min-height:16px;flex-shrink:0}
 .stats{gap:10px;margin-bottom:15px;flex-shrink:0}
 .stat{min-height:76px;padding:13px 17px}
 .stat-label{margin-bottom:9px}
 .stat strong{font-size:26px}
 .workspace-panels{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:14px;flex:1;min-height:0}
 .section{margin:0;min-height:0;display:flex;flex-direction:column}
 .section-head{flex-shrink:0;margin-bottom:9px}
 .panel{flex:1;min-height:0;overflow:hidden}
 .list-row{padding:13px 14px;gap:10px}
 .source-icon{width:32px;height:32px;flex-basis:32px}
 .delivery{padding:11px 14px}
 .delivery-copy{font-size:11px;line-height:1.4;margin:5px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
 .delivery-actions{margin:7px 0 0 36px}
 .delivery-actions .secondary{padding:5px 9px;font-size:11px}
 .record-sub{font-size:11px}
 .record-title{font-size:12px}
 .footer{margin-top:12px;flex-shrink:0}
 .settings{gap:9px;padding:14px;grid-template-columns:1fr 1fr}
 .field{gap:4px}
 .field input,.field select{height:36px;padding:7px 9px}
 .form-bottom{margin-top:2px}
 .paging{flex-shrink:0;display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px}
 .paging button{padding:5px 9px;border:1px solid var(--line);border-radius:7px;background:var(--paper);font-size:11px}
 .paging span{font-size:11px;color:var(--muted)}
 body[data-view="overview"] #add-section{display:none}
 body[data-view="sources"] #queue-section{display:none}
 body[data-view="queue"] #sources-section,body[data-view="queue"] #add-section{display:none}
 body[data-view="queue"] .workspace-panels{grid-template-columns:minmax(0,1fr)}
 .workspace-panels>.section{min-width:0}
}
@media (max-width:900px){.workspace-panels{display:block}.paging{display:none}}
@media (min-width:901px) and (max-height:700px){
 .sidebar{padding-top:17px}
 .content{padding-top:14px;padding-bottom:10px}
 .top{margin-bottom:10px}
 .heading{margin-bottom:9px}
 #notice{margin-bottom:6px}
 .stats{margin-bottom:9px}
 .stat{min-height:65px;padding:10px 14px}
 .stat-label{margin-bottom:6px}
 .list-row{padding:9px 12px}
 .delivery{padding:8px 12px}
 .footer{margin-top:8px}
}
</style>
</head>
<body>
<div class="shell">
<aside class="sidebar">
  <a href="#overview" class="brand"><span class="brand-icon">↗</span>broadcast</a>
  <nav class="nav" aria-label="セクション">
    <a class="active" href="#overview"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg><span>Overview</span></a>
    <a href="#sources-section"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M4.9 4.9a10 10 0 0 1 14.2 14.2M2 9a13 13 0 0 1 13 13"/></svg><span>Sources</span></a>
    <a href="#queue-section"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg><span>Queue</span></a>
  </nav>
  <div class="side-bottom"></div>
</aside>
<main class="content" id="overview">
  <div class="top"><div class="crumb"><span id="crumb-current">Overview</span></div><div class="top-actions"><span class="online"><span class="dot"></span> Worker online</span><button class="secondary" id="logout" style="display:none">ログアウト</button><button class="icon-button" id="refresh" title="更新" aria-label="最新情報を読み込む"><svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.6 9A7.5 7.5 0 0 1 19 7l1 5M4 12l1 5a7.5 7.5 0 0 0 13.4-2"/></svg></button></div></div>
  <div class="heading"><div><h1 id="page-title">Overview</h1><p class="sub">GitHub・RSSの更新と投稿を管理</p></div><button class="secondary" id="check-now">更新を確認</button></div>
  <p id="notice" role="status" aria-live="polite"></p>
  <div class="stats">
    <div class="stat"><div class="stat-label">監視ソース</div><strong id="stat-sources">—</strong></div>
    <div class="stat"><div class="stat-label">承認待ち</div><strong id="stat-pending">—</strong></div>
    <div class="stat"><div class="stat-label">公開済み</div><strong id="stat-published">—</strong></div>
  </div>
  <div class="workspace-panels">
  <section class="section" id="sources-section"><div class="section-head"><h2>Sources</h2><span class="section-meta" id="source-count">0 sources</span></div><div class="panel" id="sources"><div class="empty">認証後に表示します。</div></div><div class="paging" id="sources-paging"></div></section>
  <section class="section" id="queue-section"><div class="section-head"><h2>Publishing queue</h2><span class="section-meta" id="queue-count">0 posts</span></div><div class="panel" id="deliveries"><div class="empty">認証後に表示します。</div></div><div class="paging" id="queue-paging"></div></section>
  <section class="section" id="add-section"><div class="section-head"><h2>Add source</h2><span class="section-meta">GitHub / RSS</span></div>
    <div class="panel"><form class="settings" id="newSource">
      <div class="field"><label for="kind">種類</label><select id="kind"><option value="github">GitHub Releases</option><option value="rss">RSS / Atom</option></select></div>
      <div class="field"><label for="name">表示名</label><input id="name" type="text" required maxlength="100" placeholder="My project"></div>
      <div class="field full"><label for="url">URL</label><input id="url" type="url" required placeholder="https://github.com/owner/repo"></div>
      <div class="field full"><label for="image">Instagram用画像URL（任意）</label><input id="image" type="url" placeholder="https://example.com/cover.jpg"></div>
      <div class="form-bottom"><div class="checks"><label><input id="x" type="checkbox" checked>X</label><label><input id="ig" type="checkbox">Instagram</label></div><button type="submit" class="primary" id="add">ソースを追加</button></div>
    </form></div>
  </section>
  </div>
  <div class="footer"><span>Broadcast</span><span></span></div>
</main>
</div>
<div class="lock" id="lock"><div class="login">
  <div class="brand"><span class="brand-icon">↗</span>broadcast</div>
  <h2>管理画面</h2><p>管理トークンを入力してください。</p>
  <button class="primary" id="google-login" type="button" style="display:none">Googleでログイン</button>

  <p id="login-message" role="alert"></p>
</div></div>
<script>
(function(){
"use strict";
const $=id=>document.getElementById(id);
let isAuthenticated=false;
let allSources=[],allDeliveries=[],sourcePage=0,queuePage=0;
const desktop=()=>window.matchMedia("(min-width:901px)").matches;
const view=()=>document.body.dataset.view||"overview";
function setView(v){if(!["overview","sources","queue"].includes(v))v="overview";document.body.dataset.view=v;const title=({overview:"Overview",sources:"Sources",queue:"Publishing queue"})[v];$("page-title").textContent=title;$("crumb-current").textContent=title;document.querySelectorAll(".nav a").forEach(a=>a.classList.toggle("active",a.getAttribute("href")===(v==="overview"?"#overview":v==="sources"?"#sources-section":"#queue-section")));renderSources(allSources);renderQueue(allDeliveries);}
function pageControls(id,total,page,size,onClick){const p=$(id);p.replaceChildren();if(!desktop()||total<=size)return;const count=Math.ceil(total/size);p.append(el("span",null,(page+1)+" / "+count));for(const [label,n] of [["前へ",page-1],["次へ",page+1]]){const b=el("button",null,label);b.type="button";b.disabled=n<0||n>=count;b.addEventListener("click",()=>onClick(n));p.append(b);}}

const el=(tag,cls,txt)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=String(txt);return e;};
function notice(msg,bad=false){$("notice").textContent=msg;$("notice").classList.toggle("error",bad);}
async function api(path,init={}){
 const r=await fetch(path,{...init,credentials:"same-origin"});
 const body=await r.json().catch(()=>null);
 if(!r.ok)throw Error(r.status===401?"ログインの有効期限が切れました。再ログインしてください。":r.status===503?"Google OAuthの設定を確認してください。":body?.error||"HTTP "+r.status);
 return body;
}
function statusName(s){return ({pending_review:"承認待ち",scheduled:"公開待ち",processing:"送信中",published:"公開済み",failed:"失敗",unknown:"要確認",skipped:"スキップ"})[s]||s;}
function statusClass(s){return s==="pending_review"?"awaiting":s==="unknown"||s==="failed"?"failed":s==="skipped"?"muted":"";}
function shorten(s,max=75){s=String(s||"");return s.length>max?s.slice(0,max)+"…":s;}
function renderSources(sources){
 $("stat-sources").textContent=sources.length;
 $("source-count").textContent=sources.length+" sources";
 allSources=sources;const panel=$("sources");panel.replaceChildren();
 const size=desktop()?4:Infinity;if(sourcePage*size>=sources.length)sourcePage=0;
 pageControls("sources-paging",sources.length,sourcePage,size,n=>{sourcePage=n;renderSources(allSources);});
 if(!sources.length){const empty=el("div","empty");empty.append(el("strong",null,"監視ソースはありません"),el("span",null,""));panel.append(empty);return;}
 for(const s of sources.slice(sourcePage*size,sourcePage*size+size)){
   const row=el("div","list-row");const ico=el("div","source-icon",s.type==="github"?"⌘":"↗");
   const rec=el("div","record");rec.append(el("div","record-title",s.name));
   const sub=el("div","record-sub");const a=el("a",null,s.url);a.href=s.url;a.target="_blank";a.rel="noopener noreferrer";sub.append(a);rec.append(sub);
   const end=el("div","end");end.append(el("span","pill "+(s.last_check_error?"failed":""),s.last_check_error?"Error":s.enabled?"Active":"Paused"));
   if(s.last_check_error)rec.append(el("div","record-sub error-note",s.last_check_error));
   row.append(ico,rec,end);panel.append(row);
 }
}
function renderQueue(items){
 $("queue-count").textContent=items.length+" posts";
 $("stat-pending").textContent=items.filter(x=>x.status==="pending_review").length;
 $("stat-published").textContent=items.filter(x=>x.status==="published").length;
 allDeliveries=items;const panel=$("deliveries");panel.replaceChildren();
 const size=desktop()?(view()==="queue"?5:3):Infinity;if(queuePage*size>=items.length)queuePage=0;
 pageControls("queue-paging",items.length,queuePage,size,n=>{queuePage=n;renderQueue(allDeliveries);});
 if(!items.length){const empty=el("div","empty");empty.append(el("strong",null,"投稿はありません"),el("span",null,""));panel.append(empty);return;}
 for(const d of items.slice(queuePage*size,queuePage*size+size)){
  const item=el("div","delivery");const top=el("div","delivery-top");
  const platform=el("div","platform",d.platform==="x"?"𝕏":"◎");platform.title=d.platform;
  const rec=el("div","record");rec.append(el("div","record-title",d.title));
  const sub=el("div","record-sub");const a=el("a",null,d.source_name||"ソースを開く");a.href=d.source_url;a.target="_blank";a.rel="noopener noreferrer";sub.append(a);rec.append(sub);
  const end=el("div","end");end.append(el("span","pill "+statusClass(d.status),statusName(d.status)));
  top.append(platform,rec,end);item.append(top);
  if(d.text)item.append(el("p","delivery-copy",shorten(d.text,280)));
  if(d.last_error)item.append(el("p","delivery-copy error-note",d.last_error));
  if(d.status==="pending_review"){
    const buttons=el("div","delivery-actions");
    const approve=el("button","secondary","承認する");const skip=el("button","secondary","スキップ");
    approve.addEventListener("click",()=>act(d.id,"approve",d.title));skip.addEventListener("click",()=>act(d.id,"skip",d.title));
    buttons.append(approve,skip);item.append(buttons);
  }
  panel.append(item);
 }
}
async function load(){
 notice("データを読み込んでいます…");
 try{const [sources,items]=await Promise.all([api("/api/sources"),api("/api/deliveries")]);renderSources(sources);renderQueue(items);notice("最終更新: "+new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}));return true;}
 catch(e){notice("読み込みに失敗しました: "+String(e),true);throw e;}
}
async function act(id,action,title){
 const isApprove=action==="approve";
 if(!confirm((isApprove?"「"+title+"」を公開キューに送りますか？SNS認証が有効なら次回実行時に投稿されます。":"「"+title+"」をスキップしますか？")))return;
 try{await api("/api/deliveries/"+encodeURIComponent(id)+"/"+action,{method:"POST"});await load();}
 catch(e){notice(String(e),true);}
}
document.body.dataset.view="overview";
document.querySelectorAll(".nav a").forEach(a=>a.addEventListener("click",ev=>{if(desktop()){ev.preventDefault();const h=a.getAttribute("href");setView(h==="#sources-section"?"sources":h==="#queue-section"?"queue":"overview");}}));
window.addEventListener("resize",()=>{renderSources(allSources);renderQueue(allDeliveries);});
async function initAuth(){
 try{
  const res=await fetch("/api/auth/config",{cache:"no-store"});
  if(!res.ok)throw Error("認証設定の取得に失敗しました。");
  const config=await res.json();
  if(config.mode!=="google"){$("login-message").textContent="Google OAuthの設定が完了していません。";return;}
  $("google-login").style.display="block";
  const check=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});
  if(check.ok){
   isAuthenticated=true;
   $("logout").style.display="inline-flex";
   $("lock").classList.add("hidden");
   try{await load();}catch(e){notice("データの取得に失敗しました。更新してください。",true);}
  }
  const authError=new URL(location.href).searchParams.get("auth_error");
  if(authError)$("login-message").textContent=authError==="denied"?"このGoogleアカウントは許可されていません。":"Googleログインに失敗しました。もう一度お試しください。";
 }catch(e){$("login-message").textContent="認証設定を読み込めませんでした。";}
}
$("google-login").addEventListener("click",()=>{window.location.assign("/auth/google");});
$("logout").addEventListener("click",async()=>{
 try{await fetch("/auth/logout",{method:"POST",credentials:"same-origin"});}finally{window.location.assign("/");}
});
void initAuth();
$("refresh").addEventListener("click",()=>{if(!isAuthenticated)return;load().catch(()=>{});});
$("check-now").addEventListener("click",async()=>{
 if(!isAuthenticated)return;
 const b=$("check-now");b.disabled=true;b.textContent="確認中…";
 try{await api("/api/check",{method:"POST"});await load();notice("更新を確認しました。");}
 catch(e){notice("更新確認に失敗しました: "+String(e),true);}
 finally{b.disabled=false;b.textContent="更新を確認";}
});
$("newSource").addEventListener("submit",async ev=>{
 ev.preventDefault();if(!isAuthenticated)return;
 const b=$("add");b.disabled=true;
 try{await api("/api/sources",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:$("kind").value,name:$("name").value,url:$("url").value,default_image_url:$("image").value||null,post_x:$("x").checked,post_instagram:$("ig").checked})});$("newSource").reset();await load();notice("ソースを追加しました。");}
 catch(e){notice("追加できませんでした: "+String(e),true);}
 finally{b.disabled=false;}
});
})();
</script>
</body></html>`;
export default {
 async fetch(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url);
  try{
   if(req.method==="GET"&&url.pathname==="/")return new Response(page,{headers:ACCESS_HEADERS});
   if(req.method==="GET"&&url.pathname==="/api/auth/config")return json({mode:authMode(env)});
   if(req.method==="GET"&&url.pathname==="/api/auth/session"){const user=await session(req,env);return user?json({authenticated:true,email:user.email}):error("Unauthorized",401);}
   if(req.method==="GET"&&url.pathname==="/auth/google")return login(req,env);
   if(req.method==="GET"&&url.pathname==="/auth/callback")return callback(req,env);
   if(req.method==="POST"&&url.pathname==="/auth/logout"){if(!sameOrigin(req))return error("Invalid request origin",403);return logout();}
   if(req.method==="POST"&&url.pathname==="/webhooks/github")return webhook(req,env);
   if(url.pathname.startsWith("/api/"))return admin(req,env,url);
   return error("Not found",404);
  }catch(e){console.error("Request failed",String(e));return error("Internal error",500);}
 },
 async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext){
  ctx.waitUntil((async()=>{
   await env.DB.prepare("UPDATE monitoring_state SET last_cron_at=CURRENT_TIMESTAMP,last_cron_error=NULL WHERE id=1").run();
   try{await poll(env);await dispatch(env);}
   catch(e){
    await env.DB.prepare("UPDATE monitoring_state SET last_cron_error=? WHERE id=1").bind(String(e).slice(0,400)).run();
    throw e;
   }
  })());
 }
};
