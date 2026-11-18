import { authMode, callback, login, logout, sameOrigin, session } from "./auth";


interface Env {
 DB: D1Database;
 GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; SESSION_SECRET?: string; ALLOWED_EMAILS?: string;
 X_USER_ACCESS_TOKEN?: string; INSTAGRAM_ACCESS_TOKEN?: string; INSTAGRAM_USER_ID?: string;
}
type Delivery={id:string;event_id:string;platform:"x"|"instagram";text:string;image_url:string|null;attempts:number;status:string};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const error=(message:string,status=400)=>json({error:message},status);
const uid=()=>crypto.randomUUID();
const httpUrl=(value:string)=>{try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!["localhost","127.0.0.1","::1"].includes(u.hostname)&&!u.hostname.endsWith(".local")&& !u.hostname.endsWith(".internal");}catch{return false;}};
const safeId=(s:string)=>/^[a-zA-Z0-9_-]{1,70}$/.test(s);
const ACCESS_HEADERS={"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
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
 if(req.method==="GET"&&url.pathname==="/api/status"){
  const counts=await env.DB.prepare("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status").all();
  return json({ok:true,counts:counts.results,connections:{x:!!env.X_USER_ACCESS_TOKEN,instagram:!!(env.INSTAGRAM_ACCESS_TOKEN&&env.INSTAGRAM_USER_ID)}});
 }
 if(req.method==="GET"&&url.pathname==="/api/deliveries"){
  const rows=await env.DB.prepare("SELECT d.*,e.title,e.url AS source_url,s.name AS source_name,CASE WHEN s.id='manual-broadcast' THEN 1 ELSE 0 END AS is_manual FROM deliveries d JOIN events e ON e.id=d.event_id JOIN sources s ON s.id=e.source_id ORDER BY d.created_at DESC LIMIT 100").all();
  return json(rows.results);
 }
 if(req.method==="POST"&&url.pathname==="/api/posts"){
  const body:any=await req.json().catch(()=>null);
  if(!body||typeof body.text!=="string")return error("本文を入力してください");
  const message=body.text.trim();
  if(!message||message.length>2200)return error("本文は1〜2200文字で入力してください");
  const platforms=["x","instagram"].filter(p=>body[p]===true);
  if(!platforms.length)return error("投稿先を選択してください");
  if(platforms.includes("x")&&message.length>280)return error("Xへの投稿は280文字以内にしてください");
  const image=typeof body.image_url==="string"?body.image_url.trim():"";
  if(image&&!httpUrl(image))return error("画像には公開HTTPS URLを指定してください");
  if(platforms.includes("instagram")&&!image)return error("Instagramには画像URLが必要です");
  const id=uid(),eid=uid();
  await env.DB.prepare("INSERT OR IGNORE INTO sources(id,type,name,url,enabled,post_x,post_instagram) VALUES('manual-broadcast','github','Broadcast','https://broadcast.ryouy.workers.dev/',0,0,0)").run();
  await env.DB.prepare("INSERT INTO events(id,source_id,external_id,title,description,url,image_url) VALUES(?,'manual-broadcast',?,?,?,?,?)")
   .bind(eid,id,message.slice(0,70),message,"https://broadcast.ryouy.workers.dev/",image||null).run();
  for(const platform of platforms){
   await env.DB.prepare("INSERT INTO deliveries(id,event_id,platform,text,image_url) VALUES(?,?,?,?,?)")
    .bind(uid(),eid,platform,message,image||null).run();
  }
  return json({id,created:platforms.length,status:"pending_review"},201);
 }
 const match=url.pathname.match(/^\/api\/deliveries\/([\w-]+)\/(approve|skip)$/);
 if(req.method==="POST"&&match){
  const [ ,id,action]=match;
  if(!safeId(id))return error("Invalid ID");
  if(action==="approve"){
   const delivery=await env.DB.prepare("SELECT platform,image_url FROM deliveries WHERE id=? AND status='pending_review'").bind(id).first<{platform:string;image_url:string|null}>();
   if(!delivery)return json({updated:0});
   if(delivery.platform==="x"&&!env.X_USER_ACCESS_TOKEN)return error("Xの連携が未設定です。投稿はまだできません",409);
   if(delivery.platform==="instagram"&&(!env.INSTAGRAM_ACCESS_TOKEN||!env.INSTAGRAM_USER_ID))return error("Instagramの連携が未設定です。投稿はまだできません",409);
   if(delivery.platform==="x"&&delivery.image_url)return error("Xへの画像投稿にはまだ対応していません",409);
  }
  const result=await env.DB.prepare(action==="approve"?"UPDATE deliveries SET status='scheduled',scheduled_at=datetime('now') WHERE id=? AND status='pending_review'":"UPDATE deliveries SET status='skipped' WHERE id=? AND status IN ('pending_review','scheduled')").bind(id).run();
  return json({updated:result.meta.changes});
 }
 return error("Not found",404);
}
const FAVICON_SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#262626"/><path d="M19 14h19c9 0 14 6 14 12 0 6-3 10-9 12 7 1 11 5 11 12 0 9-7 14-17 14H19V14zm11 9v12h8c5 0 7-2 7-6s-3-6-8-6h-7zm0 20v12h8c6 0 9-2 9-6s-3-6-9-6h-8z" transform="translate(0 -7)" fill="#fff"/></svg>';
const page=`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f8f8f6">
<title>Broadcast | 管理画面</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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

/* Simplified Japanese administration layout */
:root{--bg:#f7f7f7;--paper:#fff;--ink:#222;--muted:#777;--line:#e7e7e7;--accent:#333}
.brand{padding:0 10px;letter-spacing:-.35px;font-weight:650;font-size:18px;gap:0}
.nav a{color:#555;border-radius:7px;font-weight:500}
.nav a.active{background:#ececec;color:#222}
.top{justify-content:flex-end}
.heading h1{font-weight:620;letter-spacing:-.7px}
.panel,.stat{border-radius:9px}
.stat{box-shadow:none}
.primary{border-radius:7px}
.secondary,.icon-button{border-radius:7px}
.pill{border-radius:5px}
.source-icon{font-size:11px;font-weight:650;color:#666;border-radius:6px}
.platform{font-size:11px}
.login{border-radius:12px;box-shadow:0 10px 30px #00000008}
@media(max-width:620px){.nav a span{display:inline}.nav a{font-size:11px;padding:8px 5px}.sidebar{padding:14px 12px}.brand{font-size:16px}}

/* Three focused top-level views, shared across phone and desktop */
.shell{display:flex;flex-direction:column;max-width:1380px;min-height:100vh}
.sidebar{height:68px;min-height:68px;padding:0 clamp(18px,3vw,42px);border:0;border-bottom:1px solid var(--line);display:flex;flex-direction:row;align-items:center;gap:clamp(14px,3vw,50px)}
.brand{font-size:19px;padding:0;white-space:nowrap}
.nav{display:flex;flex-direction:row;align-items:center;gap:22px;height:100%}
.nav a{height:100%;padding:3px 1px 0;display:flex;align-items:center;justify-content:center;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;font-size:13px;color:#777;white-space:nowrap}
.nav a.active{background:transparent;color:var(--ink);border-bottom-color:var(--ink)}
.nav a:hover{background:transparent;color:#222;text-decoration:none}
.top-actions{margin-left:auto;display:flex;gap:8px;align-items:center;white-space:nowrap}
.content{width:100%;min-width:0;max-width:100%;flex:1;display:flex;flex-direction:column;padding:25px clamp(18px,3vw,42px) 20px}
.heading{margin:0 0 12px;align-items:center;flex-shrink:0}
.heading h1{font-size:25px;margin:0;line-height:1.4}
#notice{margin:0 0 12px;min-height:15px;flex-shrink:0}
.stats{flex-shrink:0;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 22px}
.stat{min-height:90px;padding:17px 20px}
.stat-label{margin-bottom:12px}
.stat strong{font-size:29px}
.workspace-panels{display:grid;gap:18px;grid-template-columns:1fr;flex:1;min-height:0}
.section{display:flex;flex-direction:column;margin:0;min-height:0;min-width:0}
.section-head{margin:0 0 11px;flex-shrink:0}
.section-head h2{font-size:16px}
.section .panel{min-height:0;flex:1}
.paging{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px}
.paging button{padding:5px 10px;border:1px solid var(--line);border-radius:7px;background:var(--paper);cursor:pointer}
.paging button:disabled{opacity:.4}
.paging span{font-size:12px;color:var(--muted)}
body[data-view="overview"] #sources-section,
body[data-view="overview"] #add-section,
body[data-view="queue"] #sources-section,
body[data-view="queue"] #add-section,
body[data-view="sources"] #queue-section{display:none}
body[data-view="queue"] .stats,
body[data-view="sources"] .stats{display:none}
body[data-view="sources"] .workspace-panels{grid-template-columns:minmax(0,1fr) minmax(280px,.9fr)}
body[data-view="overview"] .workspace-panels,
body[data-view="queue"] .workspace-panels{grid-template-columns:minmax(0,1fr)}
body[data-view="overview"] #queue-section,
body[data-view="queue"] #queue-section{display:flex}
body[data-view="sources"] #sources-section,
body[data-view="sources"] #add-section{display:flex}
body[data-view="overview"] .delivery-copy{max-width:850px}
.section-meta{font-size:12px}
@media(min-width:901px){
 html,body{height:100%;overflow:hidden}
 .shell{height:100dvh;min-height:0;overflow:hidden;grid-template-columns:unset}
 .sidebar{height:68px;min-height:68px;padding:0 clamp(18px,3vw,42px);gap:clamp(14px,3vw,50px)}
 .content{height:auto;max-height:calc(100dvh - 68px);padding:23px clamp(18px,3vw,42px) 17px;overflow:hidden}
 .heading{margin-bottom:9px}
 .stats{margin-bottom:15px}
 .stat{min-height:79px;padding:12px 19px}
 .stat-label{margin-bottom:8px}
 .workspace-panels{gap:16px}
 .panel{overflow:hidden}
 .delivery{padding:13px 17px}
 .list-row{padding:14px 16px}
 .delivery-copy{font-size:12px;-webkit-line-clamp:2}
 .settings{grid-template-columns:1fr 1fr;padding:20px;gap:12px}
 .field input,.field select{height:40px}
 .section{margin:0}
}
@media(max-width:900px){
 .shell{display:flex;min-height:100vh}
 .sidebar{height:auto;min-height:0;display:flex;flex-wrap:wrap;padding:13px 18px 0;gap:10px 18px}
 .brand{font-size:17px}
 .top-actions{order:2;margin-left:auto}
 .nav{order:3;width:100%;height:42px;gap:24px}
 .nav a{height:42px;padding:0 1px;font-size:13px}
 .content{padding:20px 18px 35px}
 .workspace-panels{display:block}
 .section{margin:0 0 22px}
 .section .panel{flex:auto}
 body[data-view="sources"] .workspace-panels{display:block}
 .stats{margin-bottom:23px}
 .paging{display:none}
}
@media(max-width:520px){
 .sidebar{padding:12px 14px 0}
 .nav{gap:18px}
 .nav a{font-size:12px}
 .top-actions .secondary{font-size:11px;padding:8px}
 .brand{font-size:16px}
 .content{padding:19px 14px 32px}
 .heading h1{font-size:23px}
 .stats{gap:8px}
 .stat{padding:14px 11px;min-height:84px}
 .stat-label{font-size:10px;margin-bottom:13px}
 .stat strong{font-size:25px}
}

/* Direct publishing workspace */
body[data-view="overview"] #compose,body[data-view="queue"] #compose,body[data-view="compose"] #queue-section{display:none}
body[data-view="compose"] .stats,body[data-view="queue"] .stats{display:none}
body[data-view="compose"] .workspace-panels,body[data-view="overview"] .workspace-panels,body[data-view="queue"] .workspace-panels{display:grid;grid-template-columns:minmax(0,1fr)}
.compose-form{grid-template-columns:minmax(0,1fr);gap:18px;max-width:760px}
.compose-form .field label{font-size:13px}
.compose-form textarea{width:100%;min-height:170px;resize:vertical;padding:13px;border:1px solid var(--line);border-radius:7px;font:inherit;color:var(--ink);background:var(--paper);outline:none;line-height:1.7}
.compose-form textarea:focus{border-color:#999}
.compose-form .form-bottom{margin-top:0}
.hint{color:var(--muted);font-size:12px;line-height:1.6}
.nav a span{display:inline}
.record-title{font-size:13px}
@media(min-width:901px){.compose-form textarea{max-height:30dvh;min-height:120px}.compose-form .form-bottom{align-items:flex-start}.section .panel{overflow:hidden}}
@media(max-width:900px){.compose-form{display:grid;grid-template-columns:1fr}.compose-form textarea{min-height:160px}}
</style>
</head>
<body>
<div class="shell">
<header class="sidebar">
  <a href="#overview" class="brand" id="brand-link">Broadcast</a>
  <nav class="nav" aria-label="画面の切り替え">
    <a class="active" href="#overview">ホーム</a>
    <a href="#compose">投稿を作成</a>
    <a href="#queue-section">投稿一覧</a>
  </nav>
  <div class="top-actions"><button class="secondary" id="refresh" type="button">再読み込み</button><button class="secondary" id="logout" style="display:none">ログアウト</button></div>
</header>
<main class="content" id="overview">
  <div class="heading"><h1 id="page-title">ホーム</h1><button id="new-post" class="primary" type="button">新しい投稿</button></div>
  <p id="notice" role="status" aria-live="polite"></p>
  <div class="stats">
    <div class="stat"><div class="stat-label">確認待ち</div><strong id="stat-pending">—</strong></div>
    <div class="stat"><div class="stat-label">投稿予定</div><strong id="stat-scheduled">—</strong></div>
    <div class="stat"><div class="stat-label">投稿済み</div><strong id="stat-published">—</strong></div>
  </div>
  <div class="workspace-panels">
    <section class="section" id="compose"><div class="section-head"><h2>新しい投稿</h2></div>
      <div class="panel"><form class="settings compose-form" id="newPost">
        <div class="field full"><label for="post-text">投稿する文章</label><textarea id="post-text" rows="7" maxlength="2200" required placeholder="お知らせの内容を入力してください"></textarea><span class="hint" id="text-count">0文字</span></div>
        <div class="field full"><label for="post-image">画像のURL（任意）</label><input id="post-image" type="url" placeholder="https://example.com/image.jpg"><span class="hint">Instagramへの投稿には公開画像のURLが必要です。</span></div>
        <div class="field full"><label>投稿先</label><div class="checks"><label><input id="post-x" type="checkbox" checked>X</label><label><input id="post-ig" type="checkbox">Instagram</label></div></div>
        <div class="form-bottom"><span class="hint">保存後、投稿一覧で内容を確認できます。保存だけでは公開されません。</span><button class="primary" id="save-post" type="submit">確認待ちに保存</button></div>
      </form></div>
    </section>
    <section class="section" id="queue-section"><div class="section-head"><h2 id="queue-heading">最近の投稿</h2><span class="section-meta" id="queue-count">0件</span></div><div class="panel" id="deliveries"><div class="empty">認証後に表示します。</div></div><div class="paging" id="queue-paging"></div></section>
  </div>
</main>
</div>
<div class="lock" id="lock"><div class="login">
  <div class="brand">Broadcast</div><h2>管理画面</h2>
  <button class="primary" id="google-login" type="button" style="display:none">Googleでログイン</button>
  <p id="login-message" role="alert"></p>
</div></div>
<script>
(function(){
"use strict";
const $=id=>document.getElementById(id);
const el=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=String(value);return e;};
let isAuthenticated=false,allDeliveries=[],queuePage=0,connections={x:false,instagram:false};
const desktop=()=>matchMedia("(min-width:901px)").matches;
const view=()=>document.body.dataset.view||"overview";
function notice(message,bad=false){$("notice").textContent=message;$("notice").classList.toggle("error",bad);}
function setView(v){
 if(!["overview","compose","queue"].includes(v))v="overview";
 document.body.dataset.view=v;
 $("page-title").textContent=({overview:"ホーム",compose:"投稿を作成",queue:"投稿一覧"})[v];
 $("queue-heading").textContent=v==="overview"?"最近の投稿":"投稿一覧";
 $("new-post").style.display=v==="compose"?"none":"inline-flex";
 document.querySelectorAll(".nav a").forEach(a=>{
  const active=a.getAttribute("href")===(v==="overview"?"#overview":v==="compose"?"#compose":"#queue-section");
  a.classList.toggle("active",active);
  if(active)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");
 });
 renderQueue(allDeliveries);
}
function navigate(){const hash=location.hash;setView(hash==="#compose"?"compose":hash==="#queue-section"?"queue":"overview");}
function goTo(hash){history.replaceState(null,"",hash);navigate();}
document.querySelectorAll(".nav a,#brand-link").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();goTo(a.getAttribute("href"));}));
window.addEventListener("hashchange",navigate);
$("new-post").addEventListener("click",()=>{goTo("#compose");$("post-text").focus();});
navigate();
async function api(path,init={}){
 const response=await fetch(path,{...init,credentials:"same-origin"});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw Error(response.status===401?"ログインの有効期限が切れました。再ログインしてください。":data?.error||"通信に失敗しました");
 return data;
}
const statusName=s=>({pending_review:"確認待ち",scheduled:"投稿予定",processing:"送信中",published:"投稿済み",failed:"失敗",unknown:"要確認",skipped:"見送り"})[s]||s;
const statusClass=s=>s==="pending_review"?"awaiting":s==="unknown"||s==="failed"?"failed":s==="skipped"?"muted":"";
function pageControls(id,total,page,size,callback){
 const box=$(id);box.replaceChildren();
 if(!desktop()||total<=size)return;
 const count=Math.ceil(total/size);box.append(el("span",null,(page+1)+" / "+count));
 for(const [label,n] of [["前へ",page-1],["次へ",page+1]]){
  const button=el("button",null,label);button.type="button";button.disabled=n<0||n>=count;
  button.addEventListener("click",()=>callback(n));box.append(button);
 }
}
function renderQueue(items){
 allDeliveries=items;
 $("queue-count").textContent=items.length+"件";
 $("stat-pending").textContent=items.filter(x=>x.status==="pending_review").length;
 $("stat-scheduled").textContent=items.filter(x=>x.status==="scheduled").length;
 $("stat-published").textContent=items.filter(x=>x.status==="published").length;
 const box=$("deliveries");box.replaceChildren();
 const size=desktop()?(view()==="overview"?3:5):Infinity;
 if(queuePage*size>=items.length)queuePage=0;
 pageControls("queue-paging",items.length,queuePage,size,n=>{queuePage=n;renderQueue(allDeliveries);});
 if(!items.length){const empty=el("div","empty");empty.append(el("strong",null,"まだ投稿はありません"));box.append(empty);return;}
 for(const item of items.slice(queuePage*size,queuePage*size+size)){
  const row=el("div","delivery"),top=el("div","delivery-top");
  const platform=el("div","platform",item.platform==="x"?"X":"IG");platform.title=item.platform==="x"?"X":"Instagram";
  const record=el("div","record");
  record.append(el("div","record-title",item.is_manual?item.text:item.title));
  if(!item.is_manual&&item.source_url){
   const link=el("a",null,item.source_name||"元のページ");link.href=item.source_url;link.target="_blank";link.rel="noopener noreferrer";
   const sub=el("div","record-sub");sub.append(link);record.append(sub);
  }
  const end=el("div","end");end.append(el("span","pill "+statusClass(item.status),statusName(item.status)));
  top.append(platform,record,end);row.append(top);
  if(!item.is_manual&&item.text)row.append(el("p","delivery-copy",item.text.length>350?item.text.slice(0,350)+"…":item.text));
  if(item.image_url){const link=el("a","record-sub","画像を見る");link.href=item.image_url;link.target="_blank";link.rel="noopener noreferrer";row.append(link);}
  if(item.last_error)row.append(el("p","delivery-copy error-note",item.last_error));
  if(item.status==="pending_review"){
   const actions=el("div","delivery-actions"),approve=el("button","secondary","投稿を承認"),skip=el("button","secondary","見送る");
   approve.type="button";skip.type="button";
   approve.addEventListener("click",()=>act(item,"approve"));skip.addEventListener("click",()=>act(item,"skip"));
   actions.append(approve,skip);row.append(actions);
  }
  box.append(row);
 }
}
async function load(){
 notice("読み込み中…");
 try{
  const [items,status]=await Promise.all([api("/api/deliveries"),api("/api/status")]);
  connections=status.connections||{x:false,instagram:false};
  renderQueue(items);
  notice("更新: "+new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"}));
 }catch(e){notice("読み込みに失敗しました: "+String(e),true);}
}
async function act(item,action){
 if(action==="approve"&&!connections[item.platform]){
  notice((item.platform==="x"?"X":"Instagram")+"の連携が未設定です。先にアカウントを接続してください。",true);
  return;
 }
 if(!confirm(action==="approve"?"この投稿を承認しますか？ 次の配信処理でSNSに送信されます。":"この投稿を見送りますか？"))return;
 try{
  const result=await api("/api/deliveries/"+encodeURIComponent(item.id)+"/"+action,{method:"POST"});
  if(result.updated!==1)throw Error("すでに処理された可能性があります");
  await load();
 }catch(e){notice(String(e),true);}
}
function countChars(){
 const count=$("post-text").value.length;
 $("text-count").textContent=count+"文字"+($("post-x").checked?" / Xは280文字まで":"");
 $("text-count").style.color=$("post-x").checked&&count>280?"#a13d36":"";
}
$("post-text").addEventListener("input",countChars);
$("post-x").addEventListener("change",countChars);
$("newPost").addEventListener("submit",async e=>{
 e.preventDefault();if(!isAuthenticated)return;
 const message=$("post-text").value.trim(),image=$("post-image").value.trim();
 const x=$("post-x").checked,instagram=$("post-ig").checked;
 if(!message)return notice("文章を入力してください。",true);
 if(!x&&!instagram)return notice("投稿先を選んでください。",true);
 if(x&&message.length>280)return notice("Xへの投稿は280文字以内にしてください。",true);
 if(instagram&&!image)return notice("Instagramには画像のURLが必要です。",true);
 const button=$("save-post");button.disabled=true;
 try{
  await api("/api/posts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:message,image_url:image,x,instagram})});
  $("newPost").reset();countChars();await load();goTo("#queue-section");
  notice("確認待ちに保存しました。内容を確認してから承認できます。");
 }catch(err){notice("保存できませんでした: "+String(err),true);}
 finally{button.disabled=false;}
});
$("refresh").addEventListener("click",()=>{if(isAuthenticated)void load();});
async function initAuth(){
 try{
  const res=await fetch("/api/auth/config",{cache:"no-store"});if(!res.ok)throw Error();
  const config=await res.json();
  if(config.mode!=="google"){$("login-message").textContent="Google認証の設定が完了していません。";return;}
  $("google-login").style.display="block";
  const check=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});
  if(check.ok){isAuthenticated=true;$("logout").style.display="inline-flex";$("lock").classList.add("hidden");await load();}
  const authError=new URL(location.href).searchParams.get("auth_error");
  if(authError)$("login-message").textContent=authError==="denied"?"このGoogleアカウントは許可されていません。":"Googleログインに失敗しました。";
 }catch(e){$("login-message").textContent="認証設定を読み込めませんでした。";}
}
$("google-login").addEventListener("click",()=>location.assign("/auth/google"));
$("logout").addEventListener("click",async()=>{try{await fetch("/auth/logout",{method:"POST",credentials:"same-origin"});}finally{location.assign("/");}});
window.addEventListener("resize",()=>renderQueue(allDeliveries));
countChars();void initAuth();
})();
</script>
</body></html>`;
export default {
 async fetch(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url);
  try{
   if(req.method==="GET"&&url.pathname==="/favicon.svg")return new Response(FAVICON_SVG,{headers:{"content-type":"image/svg+xml; charset=utf-8","cache-control":"public,max-age=86400","x-content-type-options":"nosniff"}});
   if(req.method==="GET"&&url.pathname==="/")return new Response(page,{headers:ACCESS_HEADERS});
   if(req.method==="GET"&&url.pathname==="/api/auth/config")return json({mode:authMode(env)});
   if(req.method==="GET"&&url.pathname==="/api/auth/session"){const user=await session(req,env);return user?json({authenticated:true,email:user.email}):error("Unauthorized",401);}
   if(req.method==="GET"&&url.pathname==="/auth/google")return login(req,env);
   if(req.method==="GET"&&url.pathname==="/auth/callback")return callback(req,env);
   if(req.method==="POST"&&url.pathname==="/auth/logout"){if(!sameOrigin(req))return error("Invalid request origin",403);return logout();}
   if(url.pathname.startsWith("/api/"))return admin(req,env,url);
   return error("Not found",404);
  }catch(e){console.error("Request failed",String(e));return error("Internal error",500);}
 },
 async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext){
  ctx.waitUntil(dispatch(env));
 }
};
