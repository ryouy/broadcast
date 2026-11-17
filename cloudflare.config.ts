import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "broadcast",
    compatibilityDate: "2026-11-17",
    entrypoint,
    env: {
      DB: bindings.d1({ name: "broadcast-db" }),
      ADMIN_TOKEN: bindings.secret({ name: "ADMIN_TOKEN" }),
      GITHUB_WEBHOOK_SECRET: bindings.secret({ name: "GITHUB_WEBHOOK_SECRET" }),
      X_USER_ACCESS_TOKEN: bindings.secret({ name: "X_USER_ACCESS_TOKEN" }),
      INSTAGRAM_ACCESS_TOKEN: bindings.secret({ name: "INSTAGRAM_ACCESS_TOKEN" }),
      INSTAGRAM_USER_ID: bindings.secret({ name: "INSTAGRAM_USER_ID" })
    },
    triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })]
  }
});
