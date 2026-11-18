import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "broadcast",
    compatibilityDate: "2026-11-17",
    entrypoint,
    env: {
      DB: bindings.d1({ name: "broadcast-db" }),
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      ALLOWED_EMAILS: bindings.secret(),
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
      X_USER_ACCESS_TOKEN: bindings.secret(),
      INSTAGRAM_ACCESS_TOKEN: bindings.secret(),
      INSTAGRAM_USER_ID: bindings.secret()
    },
    triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })]
  }
});
