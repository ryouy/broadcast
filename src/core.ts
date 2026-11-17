export function normalizeText(value: string, max = 800): string {
 return value.replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|apos|#39);/g, m => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" }[m] || m)).replace(/\s+/g," ").trim().slice(0,max);
}
export function compose(title: string, description: string, url: string, platform: "x"|"instagram"): string {
 const heading=normalizeText(title,160);
 const detail=normalizeText(description, platform==="x"?95:500);
 const link=platform==="x"?url:"詳しくはプロフィールなどからご確認ください。";
 return [heading, detail, link].filter(Boolean).join("\n\n");
}
export function sourceKey(type: string, source: string, id: string): string {
 return [type,source,id].join(":");
}
export async function githubSignatureValid(body: string, signature: string|null, secret:string): Promise<boolean> {
 if(!signature?.startsWith("sha256=")||!secret) return false;
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const mac=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));
 const hex=[...mac].map(v=>v.toString(16).padStart(2,"0")).join("");
 const actual=signature.slice(7).toLowerCase();
 if(actual.length!==hex.length||!/^[0-9a-f]{64}$/.test(actual)) return false;
 let mismatch=0;for(let i=0;i<hex.length;i++)mismatch|=hex.charCodeAt(i)^actual.charCodeAt(i);
 return mismatch===0;
}
