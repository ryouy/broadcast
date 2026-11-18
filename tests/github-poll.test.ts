import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SignJWT } from "jose";

describe("direct publishing endpoint security", () => {
 const base="https://broadcast.ryouy.workers.dev";
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
 it("no longer exposes GitHub webhook or polling routes",async()=>{
  const env={DB:{} as any} as any;
  const res=await worker.fetch(new Request(base+"/webhooks/github",{method:"POST"}),env);
  expect(res.status).toBe(404);
  const poll=await worker.fetch(new Request(base+"/api/check",{method:"POST"}),env);
  expect(poll.status).toBe(503);
 });
});
