import { authMode, callback, login, logout, sameOrigin, session } from "./auth";


interface Env {
 DB: D1Database;
 GITHUB_MEDIA_TOKEN?: string;
 GITHUB_MEDIA_REPO?: string;
 GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; SESSION_SECRET?: string; ALLOWED_EMAILS?: string;
 X_USER_ACCESS_TOKEN?: string; INSTAGRAM_ACCESS_TOKEN?: string; INSTAGRAM_USER_ID?: string;
}
type Delivery={id:string;event_id:string;platform:"x"|"instagram";text:string;image_url:string|null;attempts:number;status:string};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const error=(message:string,status=400)=>json({error:message},status);
const uid=()=>crypto.randomUUID();
const httpUrl=(value:string)=>{try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!["localhost","127.0.0.1","::1"].includes(u.hostname)&&!u.hostname.endsWith(".local")&& !u.hostname.endsWith(".internal");}catch{return false;}};
const safeId=(s:string)=>/^[a-zA-Z0-9_-]{1,70}$/.test(s);
const ACCESS_HEADERS={"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' blob: https://raw.githubusercontent.com https://*.githubusercontent.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
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
  return json({ok:true,counts:counts.results,connections:{x:!!env.X_USER_ACCESS_TOKEN,instagram:!!(env.INSTAGRAM_ACCESS_TOKEN&&env.INSTAGRAM_USER_ID)},media_enabled:!!env.GITHUB_MEDIA_TOKEN});
 }
 if(req.method==="GET"&&url.pathname==="/api/deliveries"){
  const rows=await env.DB.prepare("SELECT d.*,e.title,e.image_urls,e.url AS source_url,s.name AS source_name,CASE WHEN s.id='manual-broadcast' THEN 1 ELSE 0 END AS is_manual FROM deliveries d JOIN events e ON e.id=d.event_id JOIN sources s ON s.id=e.source_id ORDER BY d.created_at DESC LIMIT 100").all();
  return json(rows.results);
 }
 if(req.method==="POST"&&url.pathname==="/api/media"){
  if(!env.GITHUB_MEDIA_TOKEN)return error("画像保存用のGitHub認証が未設定です",503);
  const len=Number(req.headers.get("content-length")||0);
  if(len>8_000_000)return error("画像は8MB以内にしてください",413);
  const type=(req.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
  const extensions:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"};
  if(!extensions[type])return error("JPEG・PNG・WebPの画像を選んでください",415);
  let bytes:Uint8Array;
  try{
   const buffer=await req.arrayBuffer();
   if(buffer.byteLength===0||buffer.byteLength>8_000_000)return error("画像は8MB以内にしてください",413);
   bytes=new Uint8Array(buffer);
  }catch{return error("画像を読み込めませんでした",400);}
  const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
  const webp=bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP";
  if(!(type==="image/jpeg"&&jpeg||type==="image/png"&&png||type==="image/webp"&&webp))return error("画像形式が正しくありません",415);
  // GitHub Contents API requires base64. Convert in chunks to avoid a large argument list.
  const githubRepo=(env.GITHUB_MEDIA_REPO||"ryouy/broadcast").trim();
  if(githubRepo.split("/").length!==2||!githubRepo.split("/").every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)))return error("画像保存先の設定が不正です",503);
  const key=uid()+"."+extensions[type];
  const path="media/"+key;
  let raw="";
  for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));
  const encoded=btoa(raw);
  const response=await fetch("https://api.github.com/repos/"+githubRepo+"/contents/"+path,{
   method:"PUT",
   headers:{
    "authorization":"Bearer "+env.GITHUB_MEDIA_TOKEN,
    "accept":"application/vnd.github+json",
    "x-github-api-version":"2022-11-28",
    "user-agent":"broadcast-media-uploader",
    "content-type":"application/json"
   },
   body:JSON.stringify({message:"media: upload image from Broadcast",content:encoded,branch:"broadcast-images"})
  });
  if(!response.ok){
   console.error("GitHub media upload failed",response.status);
   return error(response.status===401||response.status===403?"GitHubの画像保存権限を確認してください":response.status===413||response.status===422?"GitHubに画像を保存できませんでした。画像サイズを確認してください":"GitHubへの画像保存に失敗しました",502);
  }
  // Public repository: the raw file can be fetched by Instagram without credentials.
  return json({url:"https://raw.githubusercontent.com/"+githubRepo+"/broadcast-images/"+path,key},201);
 }
 if(req.method==="POST"&&url.pathname==="/api/posts"){
  const body:any=await req.json().catch(()=>null);
  if(!body||typeof body.text!=="string")return error("本文を入力してください");
  const message=body.text.trim();
  if(!message||message.length>2200)return error("本文は1〜2200文字で入力してください");
  const platforms=["x","instagram"].filter(p=>body[p]===true);
  if(!platforms.length)return error("投稿先を選択してください");
  if(platforms.includes("x")&&message.length>280)return error("Xへの投稿は280文字以内にしてください");
  const images:unknown=body.image_urls;
  if(images!==undefined&&(!Array.isArray(images)||images.length>4||images.some(x=>typeof x!=="string"||!httpUrl(x))))return error("画像は最大4枚まで、公開HTTPS URLを指定してください");
  const imageUrls:string[]=images===undefined?(typeof body.image_url==="string"&&body.image_url.trim()?[body.image_url.trim()]:[]):images as string[];
  if(imageUrls.some(x=>!httpUrl(x)))return error("画像URLが正しくありません");
  if(new Set(imageUrls).size!==imageUrls.length)return error("同じ画像を複数回指定できません");
  const image=imageUrls[0]||"";
  if(platforms.includes("instagram")&&!image)return error("Instagramには画像が必要です");
  const id=uid(),eid=uid();
  await env.DB.prepare("INSERT OR IGNORE INTO sources(id,type,name,url,enabled,post_x,post_instagram) VALUES('manual-broadcast','github','Broadcast','https://broadcast.ryouy.workers.dev/',0,0,0)").run();
  await env.DB.prepare("INSERT INTO events(id,source_id,external_id,title,description,url,image_url,image_urls) VALUES(?,'manual-broadcast',?,?,?,?,?,?)")
   .bind(eid,id,message.slice(0,70),message,"https://broadcast.ryouy.workers.dev/",image||null,JSON.stringify(imageUrls)).run();
  for(const platform of platforms){
   await env.DB.prepare("INSERT INTO deliveries(id,event_id,platform,text,image_url) VALUES(?,?,?,?,?)")
    .bind(uid(),eid,platform,message,image||null).run();
  }
  return json({id,created:platforms.length,status:"pending_review"},201);
 }
 if(req.method==="PUT"&&url.pathname.startsWith("/api/posts/")&&/^[a-f0-9-]{36}$/.test(url.pathname.slice("/api/posts/".length))){
  const eventId=url.pathname.split("/").pop()!;
  const body:any=await req.json().catch(()=>null);
  if(!body||typeof body.text!=="string")return error("本文を入力してください");
  const message=body.text.trim();
  if(!message||message.length>2200)return error("本文は1〜2200文字で入力してください");
  const platforms=(["x","instagram"] as const).filter(p=>body[p]===true);
  if(!platforms.length)return error("投稿先を選択してください");
  if(platforms.includes("x")&&message.length>280)return error("Xへの投稿は280文字以内にしてください");
  const imageUrls:unknown=body.image_urls;
  if(!Array.isArray(imageUrls)||imageUrls.length>4||imageUrls.some(x=>typeof x!=="string"||!httpUrl(x))||new Set(imageUrls).size!==imageUrls.length)return error("画像は最大4枚まで、公開HTTPS URLを指定してください");
  const images=imageUrls as string[];
  if(platforms.includes("instagram")&&!images.length)return error("Instagramには画像が必要です");
  const existing=await env.DB.prepare("SELECT d.id,d.platform,d.status,s.id AS source_id FROM deliveries d JOIN events e ON e.id=d.event_id JOIN sources s ON s.id=e.source_id WHERE d.event_id=?").bind(eventId).all<{id:string;platform:string;status:string;source_id:string}>();
  if(!existing.results.length||existing.results.some(d=>d.source_id!=="manual-broadcast"||d.status!=="pending_review"))return error("確認待ちの投稿のみ編集できます",409);
  // batch runs as a single D1 transaction, so a failed write cannot leave a partial edit.
  const queries=[
   env.DB.prepare("UPDATE events SET title=?,description=?,image_url=?,image_urls=? WHERE id=?").bind(message.slice(0,70),message,images[0]||null,JSON.stringify(images),eventId),
   env.DB.prepare("DELETE FROM deliveries WHERE event_id=? AND status='pending_review'").bind(eventId),
   ...platforms.map(platform=>env.DB.prepare("INSERT INTO deliveries(id,event_id,platform,text,image_url) VALUES(?,?,?,?,?)").bind(uid(),eventId,platform,message,images[0]||null))
  ];
  await env.DB.batch(queries);
  return json({updated:1});
 }
 const match=url.pathname.match(/^\/api\/deliveries\/([\w-]+)\/(approve|delete)$/);
 if(req.method==="POST"&&match){
  const [ ,id,action]=match;
  if(!safeId(id))return error("Invalid ID");
  if(action==="approve"){
   const delivery=await env.DB.prepare("SELECT d.platform,d.image_url,e.image_urls FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.id=? AND d.status='pending_review'").bind(id).first<{platform:string;image_url:string|null;image_urls:string|null}>();
   if(!delivery)return json({updated:0});
   if(delivery.platform==="x"&&!env.X_USER_ACCESS_TOKEN)return error("Xの連携が未設定です。投稿はまだできません",409);
   if(delivery.platform==="instagram"&&(!env.INSTAGRAM_ACCESS_TOKEN||!env.INSTAGRAM_USER_ID))return error("Instagramの連携が未設定です。投稿はまだできません",409);
   if(delivery.platform==="x"&&delivery.image_url)return error("Xへの画像投稿にはまだ対応していません",409);
   let imageCount=delivery.image_url?1:0;
   try{const parsed=JSON.parse(delivery.image_urls||"null");if(Array.isArray(parsed))imageCount=parsed.length;}catch{}
   if(delivery.platform==="instagram"&&imageCount>1)return error("Instagramへの複数画像の投稿は準備中です。保存とプレビューは利用できます",409);
  }
  if(action==="delete"){
   const result=await env.DB.prepare("DELETE FROM deliveries WHERE id=? AND status='pending_review'").bind(id).run();
   return json({updated:result.meta.changes});
  }
  const result=await env.DB.prepare("UPDATE deliveries SET status='scheduled',scheduled_at=datetime('now') WHERE id=? AND status='pending_review'").bind(id).run();
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
:root{color-scheme:light;--bg:#fff;--text:#242424;--muted:#666;--line:#dedede;--soft:#f6f6f6;--danger:#a33131}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;font-size:14px;color:var(--text);background:var(--bg)}
button,input,textarea{font:inherit}
button{cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.55}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline}
.shell{width:100%;min-height:100vh}
.site-header{border-bottom:1px solid var(--line)}
.header-inner{display:flex;align-items:center;gap:32px;max-width:1100px;margin:0 auto;height:58px;padding:0 20px}
.brand{font-size:18px;font-weight:700;white-space:nowrap}
.nav{display:flex;align-self:stretch;align-items:stretch;gap:22px}
.nav a{display:flex;align-items:center;padding:2px 2px 0;color:#6d6d6d;font-weight:500;border-bottom:2px solid transparent;white-space:nowrap}
.nav a.active{border-color:var(--text);color:var(--text)}
.header-actions{margin-left:auto}
.main{max-width:1100px;margin:auto;padding:18px 20px 30px}
.view{display:none}
body[data-view="compose"] #compose,body[data-view="queue"] #queue-section{display:block}
.view-title{margin:0 0 15px;font-size:19px;font-weight:650}
.form-area{max-width:820px}
.field{margin:0 0 14px}
.field label,.field-label{display:block;font-weight:600;margin-bottom:7px;font-size:13px}
textarea,.text-input{width:100%;display:block;border:1px solid #cfcfcf;border-radius:5px;background:white;color:var(--text);outline:none}
textarea{padding:11px 12px;min-height:205px;line-height:1.6;resize:vertical}
.text-input{height:40px;padding:8px 11px}
textarea:focus,.text-input:focus{border-color:#555}
.hint{font-size:12px;color:var(--muted);line-height:1.5}
.field-meta{display:flex;justify-content:flex-end;margin-top:5px}
.checks{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.checks label{display:flex;align-items:center;gap:7px;margin:0;font-weight:400;cursor:pointer}
.checks input{accent-color:#333}
.image-details{margin:2px 0 16px}
.image-details summary{cursor:pointer;color:#444;font-size:13px;list-style:revert}
.image-details .field{padding-top:13px;margin-bottom:2px}
.form-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:17px}
.primary{border:1px solid #222;background:#222;color:white;padding:10px 16px;border-radius:5px;font-weight:600}
.primary:hover{background:#444}
.secondary{border:1px solid #d5d5d5;background:#fff;color:#333;padding:8px 12px;border-radius:5px;font-size:13px}
.secondary:hover{background:var(--soft)}
#notice{margin:0;min-height:0;color:#555;font-size:13px}
#notice:not(:empty){margin-bottom:12px}
#notice.error{color:var(--danger)}
.list-head{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.list-head .view-title{margin:0}
.list-meta{color:var(--muted);font-size:12px}
.list-actions{margin-left:auto}
.delivery-list{border-top:1px solid var(--line)}
.delivery{padding:14px 2px;border-bottom:1px solid var(--line)}
.delivery-top{display:flex;align-items:flex-start;gap:10px}
.platform{border:1px solid #ddd;border-radius:4px;padding:3px 6px;font-size:11px;color:#555;flex:none;min-width:28px;text-align:center}
.record{flex:1;min-width:0}
.record-title{line-height:1.65;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.record-sub{font-size:12px;color:var(--muted);margin-top:4px}
.record-sub a{text-decoration:underline}
.end{margin-left:auto;flex:none}
.pill{display:inline-block;border:1px solid #dedede;color:#555;background:#f7f7f7;padding:3px 7px;border-radius:4px;font-size:12px;white-space:nowrap}
.pill.awaiting{color:#765d25;background:#fff9ea;border-color:#e9dcb5}
.pill.failed{color:var(--danger);background:#fff2f2;border-color:#edc6c6}
.delivery-copy{font-size:13px;line-height:1.6;white-space:pre-wrap;margin:8px 0 0 38px;color:var(--muted);overflow-wrap:anywhere}
.delivery-actions{display:flex;gap:8px;margin:10px 0 0 38px}
.error-note{color:var(--danger)}
.empty{padding:26px 0;color:var(--muted)}
.empty strong{font-weight:400}
.paging{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px}
.paging span{color:var(--muted);font-size:12px}
.paging button{border:1px solid #ddd;background:white;padding:5px 10px;border-radius:4px}
.lock{position:fixed;inset:0;background:#fff;z-index:9;display:flex;align-items:center;justify-content:center;padding:16px}
.lock.hidden{display:none}
.login{width:min(100%,350px);border:1px solid var(--line);border-radius:7px;padding:24px}
.login h2{font-size:18px;margin:18px 0}
.login .primary{width:100%}
#login-message{font-size:12px;color:var(--danger);line-height:1.6}
@media(max-width:650px){
 .header-inner{height:auto;min-height:58px;flex-wrap:wrap;column-gap:16px;row-gap:0;padding:0 14px}
 .brand{font-size:16px}
 .header-actions{margin-left:auto}
 .nav{order:3;width:100%;height:43px;gap:20px}
 .nav a{font-size:13px}
 .main{padding:17px 14px 26px}
 textarea{min-height:170px}
 .view-title{font-size:18px}
 .delivery{padding:12px 0}
 .delivery-copy,.delivery-actions{margin-left:0}
}

.image-upload-field input[type=file]{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.file-choose{display:flex!important;align-items:center;gap:12px;flex-wrap:wrap;cursor:pointer;border:1px dashed #999;border-radius:7px;background:#fafafa;padding:18px 20px;font-size:16px!important;font-weight:650!important}
.file-choose span{font-size:13px;font-weight:400;color:#666}
.file-choose:hover,.file-choose:focus-within{border-color:#444;background:#f4f4f4}
.image-upload-field:focus-within .file-choose{outline:2px solid #444;outline-offset:2px}
.image-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:10px;margin-top:10px;max-width:650px}
.image-preview:empty{display:none}
.upload-thumb{border:1px solid var(--line);border-radius:6px;padding:6px;min-width:0}
.upload-thumb img{display:block;width:100%;height:120px;object-fit:cover;border-radius:4px}
.upload-thumb .secondary{padding:5px 8px;margin-top:7px;font-size:13px;width:100%}
.upload-thumb .hint{display:block;margin-top:4px}
.delivery-list{border-top:0}
.delivery{padding:18px 20px;margin-bottom:12px;border:1px solid var(--line);border-radius:8px}
.record-title{font-size:17px;line-height:1.65;font-weight:500;white-space:pre-wrap}
.delivery-copy{font-size:15px;line-height:1.65;margin-left:0}
.delivery-top{gap:12px;align-items:center;flex-wrap:wrap}
.delivery-actions{margin:12px 0 0;align-items:center}
.delivery-actions .secondary{padding:8px 12px}
.delivery-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:9px;max-width:670px;margin:12px 0 2px}
.gallery-image{display:block;width:100%;padding:0;border:1px solid #ddd;background:#f8f8f8;border-radius:6px;overflow:hidden}
.gallery-image img{width:100%;height:130px;object-fit:cover;display:block}
.gallery-image:hover{border-color:#444}
.delivery-target{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:10px}
.delivery-target .platform{font-size:13px}
.image-dialog{border:0;border-radius:8px;max-width:96vw;max-height:96vh;padding:14px;background:#fff;box-shadow:0 8px 28px #0004}
.image-dialog::backdrop{background:#000c}
.image-dialog img{display:block;max-width:min(90vw,1100px);max-height:76vh;object-fit:contain}
.image-dialog-controls{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:10px}
.image-dialog-controls .secondary{font-size:14px}
@media(max-width:650px){.delivery{padding:14px 12px}.record-title{font-size:16px}.delivery-gallery{grid-template-columns:repeat(auto-fill,minmax(90px,1fr))}.gallery-image img{height:105px}.file-choose span{width:100%}}

.post-body{font-size:16px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 3px;min-width:0}
.post-body-clamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}
.post-body-expanded{display:block;overflow:visible;-webkit-line-clamp:unset;line-clamp:unset}
.post-expand{background:none;border:0;padding:5px 0;margin:2px 0 6px;color:#555;text-decoration:underline;text-underline-offset:3px;font-size:14px}
.post-expand:hover{color:#111}
.record:empty{display:none}
@media(max-width:650px){.post-body{font-size:15px}}
/* Focused, compact editor */
.main{max-width:1100px;padding-top:26px}
#compose .form-area{max-width:680px;margin:0 auto}
#compose .field{margin-bottom:19px}
#compose .field>label:not(.file-choose),#compose .field-label{font-size:14px;margin-bottom:8px;font-weight:600}
#compose textarea{height:158px;min-height:128px;max-height:55vh;padding:12px 14px;font-size:15px;line-height:1.65;border-radius:6px}
#compose .field-meta{margin-top:6px}
#compose .checks{gap:24px}
#compose .checks label{font-size:15px;display:inline-flex;gap:9px;align-items:center}
#compose .checks input{width:17px;height:17px;margin:0}
#compose .file-choose{width:100%;max-width:330px;height:72px;min-height:72px;display:flex!important;justify-content:center;align-items:center;gap:7px;padding:11px 14px;border-color:#cecece;border-radius:6px;background:#fafafa}
#compose .file-choose-title{font-size:14px;color:#222;font-weight:600}
#compose .file-choose-note{font-size:12px;color:#777;font-weight:400}
#compose .image-preview{margin-top:12px}
#compose .form-actions{margin-top:22px}
#compose .primary{min-width:112px;padding:10px 20px;font-size:14px}
@media(max-width:700px){
 .main{padding:18px 16px 26px}
 #compose .form-area{max-width:none}
 #compose textarea{height:165px;min-height:135px}
 #compose .file-choose{height:76px;max-width:330px;flex-direction:column;gap:2px}
 #compose .file-choose-note{width:auto}
}
.post-edit-button{margin-top:12px}
#cancel-edit[hidden]{display:none}
</style>
</head>
<body data-view="compose">
<div class="shell">
<header class="site-header">
 <div class="header-inner">
  <a class="brand" id="brand-link" href="#compose">Broadcast</a>
  <nav class="nav" aria-label="画面切り替え">
   <a href="#compose" class="active">投稿を作成</a>
   <a href="#queue-section">投稿一覧</a>
  </nav>
  <div class="header-actions"><button class="secondary" id="logout" style="display:none">ログアウト</button></div>
 </div>
</header>
<main class="main">
 <p id="notice" role="status" aria-live="polite"></p>
 <section class="view" id="compose">
  <form id="newPost" class="form-area">
   <div class="field">
    <label for="post-text">文章</label>
    <textarea id="post-text" rows="5" maxlength="2200" required placeholder="投稿内容を入力"></textarea>
    <div class="field-meta"><span class="hint" id="text-count">0文字</span></div>
   </div>
   <div class="field">
    <span class="field-label">投稿先</span>
    <div class="checks"><label><input id="post-x" type="checkbox" checked>X</label><label><input id="post-ig" type="checkbox">Instagram</label></div>
   </div>
   <div class="field image-upload-field">
    <label for="post-file">画像</label>
    <label class="file-choose" for="post-file"><span class="file-choose-title">画像を選択</span><span class="file-choose-note">最大4枚・ドラッグ＆ドロップ対応</span></label>
    <input id="post-file" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-describedby="upload-help">
    <div class="hint" id="upload-help"></div>
    <div id="image-preview" class="image-preview" aria-live="polite"></div>
   </div>
   <div class="form-actions">
    <button class="primary" id="save-post" type="submit">保存する</button>
    <button class="secondary" id="cancel-edit" type="button" hidden>編集をやめる</button>
   </div>
  </form>
 </section>
 <section class="view" id="queue-section">
  <div class="list-head">
   <span class="list-meta" id="queue-count">0件</span>
   <div class="list-actions"><button class="secondary" id="refresh" type="button">更新</button></div>
  </div>
  <div class="delivery-list" id="deliveries"><div class="empty">読み込み中…</div></div>
  <div class="paging" id="queue-paging"></div>
 </section>
</main>
</div>
<dialog id="image-dialog" class="image-dialog" aria-label="画像を拡大">
 <div class="image-dialog-controls"><span id="image-position"></span><button class="secondary" id="image-close" type="button">閉じる</button></div>
 <img id="image-large" alt="投稿画像">
 <div class="image-dialog-controls"><button class="secondary" id="image-prev" type="button">前の画像</button><button class="secondary" id="image-next" type="button">次の画像</button></div>
</dialog>
<div class="lock" id="lock">
 <div class="login">
  <div class="brand">Broadcast</div>
  <h2>ログイン</h2>
  <button class="primary" id="google-login" type="button" style="display:none">Googleでログイン</button>
  <p id="login-message" role="alert"></p>
 </div>
</div>
<script>
(function(){
"use strict";
const $=id=>document.getElementById(id);
const el=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=String(value);return e;};
let isAuthenticated=false,allDeliveries=[],queuePage=0,connections={x:false,instagram:false};
const desktop=()=>matchMedia("(min-width:901px)").matches;
const view=()=>document.body.dataset.view||"compose";
function notice(message,bad=false){$("notice").textContent=message;$("notice").classList.toggle("error",bad);}
function setView(v){
 if(v!=="compose"&&v!=="queue")v="compose";
 document.body.dataset.view=v;
 document.querySelectorAll(".nav a").forEach(a=>{
  const active=a.getAttribute("href")===(v==="compose"?"#compose":"#queue-section");
  a.classList.toggle("active",active);
  if(active)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");
 });
 renderQueue(allDeliveries);
}
function navigate(){setView(location.hash==="#queue-section"?"queue":"compose");}
function goTo(hash){history.replaceState(null,"",hash);navigate();}
document.querySelectorAll(".nav a,#brand-link").forEach(a=>a.addEventListener("click",e=>{e.preventDefault();goTo(a.getAttribute("href"));}));
window.addEventListener("hashchange",navigate);
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
function getImages(item){
 try{
  const values=JSON.parse(item.image_urls||"null");
  if(Array.isArray(values))return values.filter(x=>typeof x==="string"&&x.startsWith("https://")).slice(0,4);
 }catch{}
 return item.image_url?[item.image_url]:[];
}
let galleryUrls=[],galleryPosition=0;
function showImage(urls,index){
 galleryUrls=urls;galleryPosition=index;
 updateGallery();
 $("image-dialog").showModal();
}
function updateGallery(){
 $("image-large").src=galleryUrls[galleryPosition];
 $("image-position").textContent=(galleryPosition+1)+" / "+galleryUrls.length+"枚";
 $("image-prev").disabled=galleryPosition===0;
 $("image-next").disabled=galleryPosition===galleryUrls.length-1;
}
$("image-close").addEventListener("click",()=>$("image-dialog").close());
$("image-prev").addEventListener("click",()=>{galleryPosition=Math.max(0,galleryPosition-1);updateGallery();});
$("image-next").addEventListener("click",()=>{galleryPosition=Math.min(galleryUrls.length-1,galleryPosition+1);updateGallery();});
$("image-dialog").addEventListener("click",e=>{if(e.target===$("image-dialog"))$("image-dialog").close();});
$("image-dialog").addEventListener("close",()=>{$("image-large").removeAttribute("src");});
function renderQueue(items){
 allDeliveries=items;
 const groups=new Map();
 for(const item of items){
  const key=item.event_id||item.id;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(item);
 }
 const posts=[...groups.values()];
 $("queue-count").textContent=posts.length+"件";
 const box=$("deliveries");box.replaceChildren();
 const size=desktop()?6:Infinity;
 if(queuePage*size>=posts.length)queuePage=0;
 pageControls("queue-paging",posts.length,queuePage,size,n=>{queuePage=n;renderQueue(allDeliveries);});
 if(!posts.length){box.append(el("div","empty","まだ投稿はありません"));return;}
 for(const entries of posts.slice(queuePage*size,queuePage*size+size)){
  const item=entries[0],row=el("article","delivery"),top=el("div","delivery-top"),record=el("div","record");
  // Keep long text readable without making every card taller than the screen.
  if(!item.is_manual)record.append(el("div","record-title",item.title));
  top.append(record);
  row.append(top);
  const fullText=String(item.text||"");
  const body=el("p","post-body post-body-clamped",fullText);
  row.append(body);
  const needsToggle=fullText.length>100||fullText.split("\\n").length>3;
  if(needsToggle){
   const toggle=el("button","post-expand","全文を表示");
   toggle.type="button";
   toggle.setAttribute("aria-expanded","false");
   toggle.addEventListener("click",()=>{
    const expanded=body.classList.toggle("post-body-expanded");
    toggle.textContent=expanded?"閉じる":"全文を表示";
    toggle.setAttribute("aria-expanded",String(expanded));
   });
   row.append(toggle);
  }
  if(!item.is_manual&&item.source_url){
   const link=el("a","record-sub",item.source_name||"元のページ");link.href=item.source_url;link.target="_blank";link.rel="noopener noreferrer";row.append(link);
  }
  const images=getImages(item);
  if(images.length){
   const gallery=el("div","delivery-gallery");
   images.forEach((url,index)=>{
    const btn=el("button","gallery-image");btn.type="button";btn.title="画像 "+(index+1)+" を拡大";
    const img=el("img");img.src=url;img.loading="lazy";img.alt="投稿画像 "+(index+1);
    btn.append(img);btn.addEventListener("click",()=>showImage(images,index));gallery.append(btn);
   });
   row.append(gallery);
  }
  if(item.is_manual&&entries.every(d=>d.status==="pending_review")){
   const editButton=el("button","secondary post-edit-button","編集");
   editButton.type="button";
   editButton.addEventListener("click",()=>startEditing(entries));
   row.append(editButton);
  }
  for(const delivery of entries){
   const target=el("div","delivery-target");
   target.append(el("span","platform",delivery.platform==="x"?"X":"Instagram"));
   target.append(el("span","pill "+statusClass(delivery.status),statusName(delivery.status)));
   if(delivery.status==="pending_review"){
    const approve=el("button","secondary","承認"),remove=el("button","secondary","削除");
    approve.type="button";remove.type="button";
    approve.addEventListener("click",()=>act(delivery,"approve"));
    remove.addEventListener("click",()=>act(delivery,"delete"));
    target.append(approve,remove);
   }
   row.append(target);
   if(delivery.last_error)row.append(el("p","delivery-copy error-note",delivery.last_error));
  }
  box.append(row);
 }
}
async function load(){
 notice("読み込み中…");
 try{
  const [items,status]=await Promise.all([api("/api/deliveries"),api("/api/status")]);
  connections=status.connections||{x:false,instagram:false};
  mediaEnabled=status.media_enabled===true;
  $("post-file").disabled=!mediaEnabled;
  renderSelectedImages();
  renderQueue(items);
  notice("");
 }catch(e){notice("読み込みに失敗しました: "+String(e),true);}
}
async function act(item,action){
 if(action==="approve"&&!connections[item.platform]){
  notice((item.platform==="x"?"X":"Instagram")+"の連携が未設定です。先にアカウントを接続してください。",true);
  return;
 }
 if(!confirm(action==="approve"?"この投稿を承認しますか？ 次の配信処理でSNSに送信されます。":"この投稿を削除しますか？ 元に戻せません。"))return;
 try{
  const result=await api("/api/deliveries/"+encodeURIComponent(item.id)+"/"+action,{method:"POST"});
  if(result.updated!==1)throw Error("すでに処理された可能性があります");
  await load();
 }catch(e){notice(String(e),true);}
}
let mediaEnabled=false,selectedFiles=[],selectedPreviews=[],existingImages=[],editingEventId=null;
function resetEditor(){
 editingEventId=null;
 existingImages=[];
 $("save-post").textContent="保存する";
 $("cancel-edit").hidden=true;
 $("newPost").reset();
 clearImages();
 countChars();
}
function startEditing(entries){
 const item=entries[0];
 editingEventId=item.event_id;
 existingImages=getImages(item).slice();
 selectedFiles=[];
 selectedPreviews.forEach(url=>URL.revokeObjectURL(url));
 selectedPreviews=[];
 $("post-file").value="";
 $("post-text").value=item.text;
 $("post-x").checked=entries.some(d=>d.platform==="x");
 $("post-ig").checked=entries.some(d=>d.platform==="instagram");
 $("save-post").textContent="変更を保存";
 $("cancel-edit").hidden=false;
 renderSelectedImages();
 countChars();
 goTo("#compose");
 $("post-text").focus();
 window.scrollTo({top:0,behavior:"instant"});
 notice("");
}
$("cancel-edit").addEventListener("click",()=>{resetEditor();notice("");});

function clearImages(){
 selectedPreviews.forEach(url=>URL.revokeObjectURL(url));
 selectedFiles=[];selectedPreviews=[];
 $("post-file").value="";
 renderSelectedImages();
}
function renderSelectedImages(){
 const box=$("image-preview");box.replaceChildren();
 existingImages.forEach((url,i)=>{
  const wrapper=el("div","upload-thumb");
  const img=el("img");img.src=url;img.alt="登録済み画像 "+(i+1);img.loading="lazy";
  wrapper.append(img,el("span","hint","登録済み"));
  const remove=el("button","secondary","削除");remove.type="button";
  remove.addEventListener("click",()=>{existingImages.splice(i,1);renderSelectedImages();});
  wrapper.append(remove);box.append(wrapper);
 });
 selectedFiles.forEach((file,i)=>{
  const wrapper=el("div","upload-thumb");
  const img=el("img");img.src=selectedPreviews[i];img.alt="選択した画像 "+(i+1);
  wrapper.append(img,el("span","hint",(i+1)+"枚目"));
  const remove=el("button","secondary","削除");remove.type="button";
  remove.addEventListener("click",()=>{
   URL.revokeObjectURL(selectedPreviews[i]);
   selectedFiles.splice(i,1);selectedPreviews.splice(i,1);renderSelectedImages();
  });
  wrapper.append(remove);box.append(wrapper);
 });
 $("upload-help").textContent=mediaEnabled?(existingImages.length+selectedFiles.length?"画像 "+(existingImages.length+selectedFiles.length)+" / 4枚":""):"画像保存のGitHub設定が必要です";
}
function addImages(files){
 if(!mediaEnabled){notice("画像保存のGitHub設定が必要です",true);return;}
 const incoming=[...files];
 if(existingImages.length+selectedFiles.length+incoming.length>4){notice("画像は1投稿につき4枚までです",true);return;}
 for(const file of incoming){
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size===0||file.size>8_000_000){
   notice("JPEG・PNG・WebPの画像を、1枚8MB以内で選んでください",true);return;
  }
 }
 incoming.forEach(file=>{selectedFiles.push(file);selectedPreviews.push(URL.createObjectURL(file));});
 renderSelectedImages();
 notice("");
}
$("post-file").addEventListener("change",e=>{addImages(e.target.files||[]);e.target.value="";});
const dropZone=document.querySelector(".file-choose");
dropZone.addEventListener("dragover",e=>{e.preventDefault();});
dropZone.addEventListener("drop",e=>{e.preventDefault();addImages(e.dataTransfer?.files||[]);});
async function uploadSelectedImages(){
 if(selectedFiles.length&&!mediaEnabled)throw Error("画像保存のGitHub設定が必要です");
 const urls=[];
 for(let i=0;i<selectedFiles.length;i++){
  notice("画像を保存中… "+(i+1)+" / "+selectedFiles.length+"枚");
  const file=selectedFiles[i];
  const response=await api("/api/media",{method:"POST",headers:{"content-type":file.type},body:file});
  if(typeof response.url!=="string")throw Error("画像 "+(i+1)+" の保存に失敗しました");
  urls.push(response.url);
 }
 return urls;
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
 const message=$("post-text").value.trim();
 const x=$("post-x").checked,instagram=$("post-ig").checked;
 if(!message)return notice("文章を入力してください。",true);
 if(!x&&!instagram)return notice("投稿先を選んでください。",true);
 if(x&&message.length>280)return notice("Xへの投稿は280文字以内にしてください。",true);
 if(instagram&&!existingImages.length&&!selectedFiles.length)return notice("Instagramには画像が必要です。",true);
 const button=$("save-post");button.disabled=true;
 try{
  const images=[...existingImages,...await uploadSelectedImages()];
  const editing=Boolean(editingEventId);
  const endpoint=editing?"/api/posts/"+encodeURIComponent(editingEventId):"/api/posts";
  await api(endpoint,{method:editing?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:message,image_urls:images,x,instagram})});
  resetEditor();await load();goTo("#queue-section");
  notice(editing?"変更を保存しました。":"確認待ちに保存しました。");
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
