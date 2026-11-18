import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SignJWT } from "jose";

describe("direct publishing endpoint security", () => {
 const base="https://broadcast.ryouy.workers.dev";
 afterEach(()=>vi.unstubAllGlobals());
 it("keeps manual drafts behind Google authentication",async()=>{
  const req=new Request(base+"/api/posts",{method:"POST",headers:{"origin":base,"content-type":"application/json"},body:JSON.stringify({text:"お知らせ",x:true})});
  const res=await worker.fetch(req,{DB:{} as any} as any);
  expect(res.status).toBe(503);
 });
 it("creates a review-only draft through a valid Google session",async()=>{
  const writes:Array<{sql:string;params:unknown[]}>=[],secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const db={prepare(sql:string){return {bind(...params:unknown[]){return {run:async()=>{writes.push({sql,params});return {meta:{changes:1}};}};},run:async()=>{writes.push({sql,params:[]});return {meta:{changes:1}};}};}};
  const env={DB:db,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const request=new Request(base+"/api/posts",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"application/json"},body:JSON.stringify({text:"新しいお知らせです",x:true,instagram:false})});
  const response=await worker.fetch(request,env);
  expect(response.status).toBe(201);
  const result=await response.json() as {created:number;status:string};
  expect(result).toMatchObject({created:1,status:"pending_review"});
  expect(writes.filter(x=>x.sql.startsWith("INSERT INTO deliveries"))).toHaveLength(1);
  expect(writes.find(x=>x.sql.startsWith("INSERT INTO deliveries"))?.params[3]).toBe("新しいお知らせです");
 });
 it("deletes only pending deliveries instead of marking them skipped",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const statements:Array<{sql:string;params:unknown[]}>=[],db={prepare(sql:string){return {bind(...params:unknown[]){return {run:async()=>{statements.push({sql,params});return {meta:{changes:1}};}};}};}};
  const env={DB:db,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const req=new Request(base+"/api/deliveries/example-id/delete",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token}});
  const res=await worker.fetch(req,env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({updated:1});
  expect(statements).toEqual([{sql:"DELETE FROM deliveries WHERE id=? AND status='pending_review'",params:["example-id"]}]);
 });
 it("edits a pending manual post and replaces its platform deliveries atomically",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const eventId="17af47b2-85dc-492f-a142-9673ec447075";
  const batched:Array<{sql:string;params:unknown[]}[]>=[];
  const db={prepare(sql:string){return {bind(...params:unknown[]){return {sql,params,all:async()=>({results:[{id:"old-id",platform:"x",status:"pending_review",source_id:"manual-broadcast"}]})};}};},batch:async(queries:Array<{sql:string;params:unknown[]}> )=>{batched.push(queries);return queries.map(()=>({meta:{changes:1}}));}};
  const env={DB:db,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const images=["https://raw.githubusercontent.com/ryouy/broadcast/broadcast-images/media/a.png"];
  const req=new Request(base+"/api/posts/"+eventId,{method:"PUT",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"application/json"},body:JSON.stringify({text:"編集した投稿",x:true,instagram:true,image_urls:images})});
  const res=await worker.fetch(req,env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({updated:1});
  expect(batched).toHaveLength(1);
  expect(batched[0]).toHaveLength(4);
  expect(batched[0][0].sql).toContain("UPDATE events");
  expect(batched[0][0].params).toEqual(["編集した投稿","編集した投稿",images[0],JSON.stringify(images),eventId]);
  expect(batched[0][1].sql).toContain("DELETE FROM deliveries");
  expect(batched[0][2].params[2]).toBe("x");
  expect(batched[0][3].params[2]).toBe("instagram");
 });
 it("rejects edits if any delivery was already approved",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const db={prepare(sql:string){return {bind(){return {all:async()=>({results:[{id:"existing",platform:"x",status:"scheduled",source_id:"manual-broadcast"}]})};}};},batch:async()=>{throw Error("must not edit");}};
  const env={DB:db,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const eventId="17af47b2-85dc-492f-a142-9673ec447075";
  const req=new Request(base+"/api/posts/"+eventId,{method:"PUT",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"application/json"},body:JSON.stringify({text:"変更",x:true,image_urls:[]})});
  expect((await worker.fetch(req,env)).status).toBe(409);
 });
 it("saves ordered multiple images in the post record",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const writes:Array<{sql:string;params:unknown[]}>=[];
  const db={prepare(sql:string){return {bind(...params:unknown[]){return {run:async()=>{writes.push({sql,params});return {meta:{changes:1}};}};},run:async()=>({meta:{changes:1}})};}};
  const env={DB:db,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const images=["https://raw.githubusercontent.com/ryouy/broadcast/broadcast-images/media/one.jpg","https://raw.githubusercontent.com/ryouy/broadcast/broadcast-images/media/two.jpg"];
  const req=new Request(base+"/api/posts",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"application/json"},body:JSON.stringify({text:"お知らせ",instagram:true,image_urls:images})});
  const res=await worker.fetch(req,env);
  expect(res.status).toBe(201);
  const event=writes.find(x=>x.sql.startsWith("INSERT INTO events"));
  expect(event?.sql).toContain("image_urls");
  expect(event?.params[6]).toBe(JSON.stringify(images));
  expect(writes.filter(x=>x.sql.startsWith("INSERT INTO deliveries"))).toHaveLength(1);
 });
 it("rejects more than four images on a post",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const env={DB:{} as any,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const images=Array.from({length:5},(_,i)=>"https://example.com/"+i+".jpg");
  const req=new Request(base+"/api/posts",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"application/json"},body:JSON.stringify({text:"お知らせ",x:true,image_urls:images})});
  expect((await worker.fetch(req,env)).status).toBe(400);
 });
 it("no longer exposes GitHub webhook or polling routes",async()=>{
  const env={DB:{} as any} as any;
  const res=await worker.fetch(new Request(base+"/webhooks/github",{method:"POST"}),env);
  expect(res.status).toBe(404);
  const poll=await worker.fetch(new Request(base+"/api/check",{method:"POST"}),env);
  expect(poll.status).toBe(503);
 });
 it("rejects image upload without GitHub token",async()=>{
  const baseSecret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(baseSecret));
  const env={DB:{} as any,GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:baseSecret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const res=await worker.fetch(new Request(base+"/api/media",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"image/png"},body:new Uint8Array([137,80,78,71,13,10,26,10,0])}),env);
  expect(res.status).toBe(503);
 });
 it("uploads a valid PNG to the dedicated GitHub media branch",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const sent:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async (url:string,init:RequestInit)=>{
   sent.push({url,init});
   return new Response(JSON.stringify({content:{path:"media/example.png"}}),{status:201,headers:{"content-type":"application/json"}});
  }));
  const env={DB:{} as any,GITHUB_MEDIA_TOKEN:"github-test-token",GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const res=await worker.fetch(new Request(base+"/api/media",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"image/png"},body:png}),env);
  expect(res.status).toBe(201);
  const output=await res.json() as {url:string;key:string};
  expect(output.url).toBe("https://raw.githubusercontent.com/ryouy/broadcast/broadcast-images/media/"+output.key);
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toContain("https://api.github.com/repos/ryouy/broadcast/contents/media/");
  expect(sent[0].init.headers.authorization).toBe("Bearer github-test-token");
  const payload=JSON.parse(sent[0].init.body);
  expect(payload.branch).toBe("broadcast-images");
  expect(payload.content).toBe("iVBORw0KGgoA");
 });
 it("rejects an image with a forged media type",async()=>{
  const secret="test-session-secret-with-adequate-length";
  const token=await new SignJWT({email:"alice@gmail.com",sub:"alice"}).setProtectedHeader({alg:"HS256"}).setIssuer(base).setAudience("admin").setIssuedAt().setExpirationTime("2h").sign(new TextEncoder().encode(secret));
  const env={DB:{} as any,GITHUB_MEDIA_TOKEN:"github-test-token",GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:secret,ALLOWED_EMAILS:"alice@gmail.com"} as any;
  const res=await worker.fetch(new Request(base+"/api/media",{method:"POST",headers:{Origin:base,Cookie:"__Host-broadcast_session="+token,"Content-Type":"image/png"},body:new Uint8Array([1,2,3,4,5,6,7,8,9])}),env);
  expect(res.status).toBe(415);
 });
});
