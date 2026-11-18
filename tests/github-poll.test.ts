import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("direct publishing endpoint security", () => {
 const base="https://broadcast.ryouy.workers.dev";
 it("keeps manual drafts behind Google authentication",async()=>{
  const req=new Request(base+"/api/posts",{method:"POST",headers:{"origin":base,"content-type":"application/json"},body:JSON.stringify({text:"お知らせ",x:true})});
  const res=await worker.fetch(req,{DB:{} as any} as any);
  expect(res.status).toBe(503);
 });
 it("no longer exposes GitHub webhook or polling routes",async()=>{
  const env={DB:{} as any} as any;
  const res=await worker.fetch(new Request(base+"/webhooks/github",{method:"POST"}),env);
  expect(res.status).toBe(404);
  const poll=await worker.fetch(new Request(base+"/api/check",{method:"POST"}),env);
  expect(poll.status).toBe(503);
 });
});
