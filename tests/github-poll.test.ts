import { afterEach, describe, expect, it, vi } from "vitest";
import { pollGitHub } from "../src/index";

describe("GitHub release polling", () => {
 afterEach(() => vi.unstubAllGlobals());

 it("enqueues each published release once across repeated polls", async () => {
  const inserted = new Map<string, string>();
  const deliveries: Array<{ eventId: string; platform: string; status: string }> = [];
  const statements: string[] = [];
  const db = {
   prepare(sql: string) {
    statements.push(sql);
    return {
     bind(...params: unknown[]) {
      return {
       async run() {
        if (sql.startsWith("INSERT OR IGNORE INTO events")) {
         const [id, sourceId, externalId] = params as string[];
         const key = sourceId + ":" + externalId;
         if (inserted.has(key)) return { meta: { changes: 0 } };
         inserted.set(key, id);
         return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO deliveries")) {
         const [,eventId,platform] = params as string[];
         deliveries.push({eventId, platform, status:"pending_review"});
         return { meta: { changes: 1 } };
        }
        throw Error("Unexpected SQL: " + sql);
       }
      };
     }
    };
   }
  };
  const releases = [
   {id:101, tag_name:"v0.1.1", name:"Broadcast v0.1.1", published_at:"2026-11-18T05:00:00Z", html_url:"https://github.com/ryouy/broadcast/releases/tag/v0.1.1", body:"Release notes", draft:false, prerelease:false},
   {id:102, tag_name:"v0.2.0-beta", name:"Beta", published_at:"2026-11-18T06:00:00Z", html_url:"https://github.com/ryouy/broadcast/releases/tag/v0.2.0-beta", body:"", draft:false, prerelease:true},
   {id:103, tag_name:"v0.2.0", name:"Draft", published_at:null, html_url:"https://github.com/ryouy/broadcast/releases/tag/v0.2.0", draft:true, prerelease:false}
  ];
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(releases), { status:200, headers:{"content-type":"application/json"} }));
  vi.stubGlobal("fetch",fetchMock);
  const source = {id:"github-broadcast", type:"github", name:"Broadcast", url:"https://github.com/ryouy/broadcast", post_x:1, post_instagram:0};
  await pollGitHub({DB:db} as any,source as any);
  await pollGitHub({DB:db} as any,source as any);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(inserted.size).toBe(1);
  expect(inserted.has("github-broadcast:101")).toBe(true);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({platform:"x",status:"pending_review"});
  expect(statements.some(s=>s.startsWith("INSERT OR IGNORE INTO events"))).toBe(true);
 });
});
