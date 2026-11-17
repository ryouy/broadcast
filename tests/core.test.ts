import { describe,it,expect } from "vitest";
import { compose,normalizeText,githubSignatureValid,sourceKey } from "../src/core";
describe("content generation",()=>{
 it("normalizes markup and whitespace",()=>expect(normalizeText("<b>Hello</b> &amp;  world")).toBe("Hello & world"));
 it("creates distinct platform captions",()=>{
  const x=compose("New release","Some fixes","https://example.com","x");
  const ig=compose("New release","Some fixes","https://example.com","instagram");
  expect(x).toContain("https://example.com"); expect(ig).not.toContain("https://example.com");
 });
 it("keys separate sources independently",()=>expect(sourceKey("rss","a","1")).not.toBe(sourceKey("rss","b","1")));
});
describe("webhook verification",()=>{
 it("rejects empty signatures",async()=>expect(await githubSignatureValid("{}",null,"secret")).toBe(false));
 it("accepts signed bodies and rejects tampering",async()=>{
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("secret"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signed=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("hello")));
  const signature="sha256="+[...signed].map(x=>x.toString(16).padStart(2,"0")).join("");
  expect(await githubSignatureValid("hello",signature,"secret")).toBe(true);
  expect(await githubSignatureValid("world",signature,"secret")).toBe(false);
 });
});
