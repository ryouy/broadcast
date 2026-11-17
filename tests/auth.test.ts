import { describe, expect, it } from "vitest";
import { authMode, permittedEmail, sameOrigin, login, session, logout, BASE_URL } from "../src/auth";

describe("Google OAuth authentication", () => {
 it("keeps legacy token login only until OAuth setup begins", () => {
  expect(authMode({ADMIN_TOKEN:"existing"})).toBe("token");
  expect(authMode({GOOGLE_CLIENT_ID:"test"})).toBe("unconfigured");
  expect(authMode({GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:"long-key",ALLOWED_EMAILS:"alice@gmail.com"})).toBe("google");
 });
 it("permits only exact email entries (not similar domains)", () => {
  expect(permittedEmail("ALICE@gmail.com","alice@gmail.com, bob@example.com")).toBe(true);
  expect(permittedEmail("alice@gmail.com.evil.test","alice@gmail.com")).toBe(false);
  expect(permittedEmail("mallory@gmail.com","alice@gmail.com")).toBe(false);
  expect(permittedEmail("bob@example.com","alice@gmail.com\nbob@example.com")).toBe(true);
 });
 it("blocks cross-origin API mutations", () => {
  expect(sameOrigin(new Request(BASE_URL+"/api/check",{headers:{Origin:BASE_URL}}))).toBe(true);
  expect(sameOrigin(new Request(BASE_URL+"/api/check",{headers:{Origin:"https://evil.test"}}))).toBe(false);
  expect(sameOrigin(new Request(BASE_URL+"/api/check"))).toBe(false);
 });
 it("redirects to Google with PKCE and an HttpOnly state cookie", async () => {
  const res=await login(new Request(BASE_URL+"/auth/google"),{GOOGLE_CLIENT_ID:"client-id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:"test-symmetric-session-secret-123",ALLOWED_EMAILS:"alice@gmail.com"});
  expect(res.status).toBe(302);
  const url=new URL(res.headers.get("Location")!);
  expect(url.hostname).toBe("accounts.google.com");
  expect(url.searchParams.get("redirect_uri")).toBe(BASE_URL+"/auth/callback");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("nonce")).toBeTruthy();
  expect(res.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
 });
 it("rejects unauthenticated sessions and expires the cookie on logout", async () => {
  const env={GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",SESSION_SECRET:"long-key",ALLOWED_EMAILS:"alice@gmail.com"};
  expect(await session(new Request(BASE_URL),env)).toBeNull();
  const res=logout();
  expect(res.status).toBe(303);
  expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
 });
});
