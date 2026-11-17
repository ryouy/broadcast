import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";

export interface AuthEnv {
 GOOGLE_CLIENT_ID?: string;
 GOOGLE_CLIENT_SECRET?: string;
 SESSION_SECRET?: string;
 ALLOWED_EMAILS?: string;
 ADMIN_TOKEN?: string; // Temporary fallback until Google OAuth is configured.
}

export const BASE_URL = "https://broadcast.ryouy.workers.dev";
const CALLBACK = BASE_URL + "/auth/callback";
const SESSION_COOKIE = "__Host-broadcast_session";
const FLOW_COOKIE = "__Secure-broadcast_oauth";
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const utf8 = (secret: string) => new TextEncoder().encode(secret);
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("");
const parseCookies = (req: Request) => Object.fromEntries((req.headers.get("cookie") || "").split(";").map(p => p.trim()).filter(Boolean).map(p => { const index = p.indexOf("=");return [p.slice(0,index),p.slice(index+1)]; }));
const cookie = (name:string,value:string,maxAge:number,path="/") => name+"="+value+"; Path="+path+"; Max-Age="+maxAge+"; HttpOnly; Secure; SameSite=Lax";
const redirect = (location:string,headers?:HeadersInit) => {const h=new Headers(headers);h.set("Location",location);h.set("Cache-Control","no-store");return new Response(null,{status:303,headers:h});};

export function authMode(env:AuthEnv):"google"|"token"|"unconfigured"{
 const anyGoogle = Boolean(env.GOOGLE_CLIENT_ID||env.GOOGLE_CLIENT_SECRET||env.SESSION_SECRET||env.ALLOWED_EMAILS);
 const configured = Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.SESSION_SECRET&&env.ALLOWED_EMAILS);
 return configured?"google":anyGoogle?"unconfigured":"token";
}
export function permittedEmail(email:string,allowlist:string):boolean{
 return allowlist.split(/[;,\n]/).map(s=>s.trim().toLowerCase()).filter(Boolean).includes(email.trim().toLowerCase());
}
export function sameOrigin(req:Request):boolean{
 return req.headers.get("origin")===BASE_URL;
}
async function signed(payload:Record<string,unknown>,secret:string,minutes:number,audience:string):Promise<string>{
 return new SignJWT(payload).setProtectedHeader({alg:"HS256"}).setIssuer(BASE_URL).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+minutes*60).sign(utf8(secret));
}
async function verified(token:string,secret:string,audience:string){
 const result=await jwtVerify(token,utf8(secret),{issuer:BASE_URL,audience,algorithms:["HS256"]});
 return result.payload;
}
export async function login(req:Request,env:AuthEnv):Promise<Response>{
 if(authMode(env)!=="google")return new Response("Google OAuth is not configured",{status:503});
 const state=random(),nonce=random(),verifier=random();
 const hash=await crypto.subtle.digest("SHA-256",utf8(verifier));
 const challenge=btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
 const flow=await signed({state,nonce,verifier},env.SESSION_SECRET!,5,"oauth-flow");
 const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");
 for(const [k,v] of Object.entries({client_id:env.GOOGLE_CLIENT_ID!,redirect_uri:CALLBACK,response_type:"code",scope:"openid email profile",state,nonce,code_challenge:challenge,code_challenge_method:"S256",prompt:"select_account"}))u.searchParams.set(k,v);
 const headers=new Headers({Location:u.toString(),"Cache-Control":"no-store"});
 headers.append("Set-Cookie",cookie(FLOW_COOKIE,flow,300,"/auth"));
 return new Response(null,{status:302,headers});
}
export async function callback(req:Request,env:AuthEnv):Promise<Response>{
 if(authMode(env)!=="google")return new Response("Google OAuth is not configured",{status:503});
 const url=new URL(req.url);
 const clean=new Headers({"Cache-Control":"no-store"});
 clean.append("Set-Cookie",cookie(FLOW_COOKIE,"",0,"/auth"));
 const state=url.searchParams.get("state"),code=url.searchParams.get("code");
 if(!state||!code||url.searchParams.has("error"))return redirect("/?auth_error=cancelled",clean);
 let flow;
 try{flow=await verified(parseCookies(req)[FLOW_COOKIE]||"",env.SESSION_SECRET!,"oauth-flow");}
 catch{return redirect("/?auth_error=expired",clean);}
 if(typeof flow.state!=="string"||state!==flow.state||typeof flow.verifier!=="string"||typeof flow.nonce!=="string")return redirect("/?auth_error=invalid",clean);
 const body=new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID!,client_secret:env.GOOGLE_CLIENT_SECRET!,redirect_uri:CALLBACK,grant_type:"authorization_code",code_verifier:flow.verifier});
 const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body,signal:AbortSignal.timeout(12000)});
 if(!response.ok)return redirect("/?auth_error=exchange",clean);
 const tokenResponse:any=await response.json();
 if(typeof tokenResponse.id_token!=="string")return redirect("/?auth_error=invalid",clean);
 let profile;
 try{
  profile=(await jwtVerify(tokenResponse.id_token,googleKeys,{issuer:["https://accounts.google.com","accounts.google.com"],audience:env.GOOGLE_CLIENT_ID,algorithms:["RS256"]})).payload;
 }catch{return redirect("/?auth_error=invalid",clean);}
 const email=String(profile.email||"").trim().toLowerCase();
 if(!email||profile.email_verified!==true||!permittedEmail(email,env.ALLOWED_EMAILS!)||profile.nonce!==flow.nonce||typeof profile.sub!=="string")return redirect("/?auth_error=denied",clean);
 const session=await signed({email,sub:profile.sub},env.SESSION_SECRET!,480,"admin");
 clean.append("Set-Cookie",cookie(SESSION_COOKIE,session,8*3600));
 return redirect("/",clean);
}
export async function session(req:Request,env:AuthEnv):Promise<{email:string;sub:string}|null>{
 if(authMode(env)!=="google")return null;
 try{
  const jwt=parseCookies(req)[SESSION_COOKIE];if(!jwt)return null;
  const payload=await verified(jwt,env.SESSION_SECRET!,"admin");
  if(typeof payload.email!=="string"||typeof payload.sub!=="string"||!permittedEmail(payload.email,env.ALLOWED_EMAILS!))return null;
  return {email:payload.email,sub:payload.sub};
 }catch{return null;}
}
export function logout():Response{
 return redirect("/",{"Set-Cookie":cookie(SESSION_COOKIE,"",0)});
}
