import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

describe("dashboard", () => {
 const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
 const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 it("contains the new dashboard and core controls", () => {
  expect(source).toContain("Welcome back.");
  expect(source).toContain("Publishing queue");
  expect(source).toContain('id="login-form"');
  expect(source).toContain('id="newSource"');
 });
 it("client-side JavaScript parses without syntax errors", () => {
  expect(script).toBeTruthy();
  expect(() => new Script(script!)).not.toThrow();
 });
});
