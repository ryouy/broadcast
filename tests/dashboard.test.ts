import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

describe("dashboard", () => {
 const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
 const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 it("contains the new dashboard and core controls", () => {
  expect(source).toContain("管理画面");
  expect(source).not.toContain("発信するものを、ひとつの場所で。");
  expect(source).not.toContain("PERSONAL WORKSPACE");
  expect(source).toContain("投稿の確認");
  expect(source).toContain("更新元の設定");
  expect(source).toContain("ホーム");
  expect(source).not.toContain("GitHub・RSSの更新と投稿を管理");
  expect(source).not.toContain("Worker online");
  expect(source).toContain('href="/favicon.svg"');
  expect(source).toContain('url.pathname==="/favicon.svg"');
  expect(source).toContain("<h2>登録済みの更新元</h2>");
  expect(source).toContain("<h2>更新元を追加</h2>");
  expect(source).toContain("window.addEventListener(\"hashchange\",navigationFromHash)");
  expect(source.indexOf("<header class=\"sidebar\">")).toBeLessThan(source.indexOf("<main class=\"content\""));
  expect(source).not.toContain('id="login-form"');
  expect(source).not.toContain('ADMIN_TOKEN');
  expect(source).not.toContain('if(!token)return');
  expect(source).toContain('if(!isAuthenticated)return');
  const configRoute=source.indexOf('url.pathname==="/api/auth/config"');
  const adminRoute=source.lastIndexOf('url.pathname.startsWith("/api/")');
  expect(configRoute).toBeGreaterThan(0);
  expect(configRoute).toBeLessThan(adminRoute);
  expect(source).toContain('url.pathname==="/auth/google"');
  expect(source).toContain('url.pathname==="/auth/callback"');
  expect(source).toContain('id="newSource"');
  expect(source).toContain('class="workspace-panels"');
  expect(source).toContain('id="queue-paging"');
  expect(source).toContain('height:100dvh');
  expect(source).toContain('overflow:hidden');
 });
 it("client-side JavaScript parses without syntax errors", () => {
  expect(script).toBeTruthy();
  expect(() => new Script(script!)).not.toThrow();
 });
});
