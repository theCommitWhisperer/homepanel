import { describe, expect, it } from "vitest";
import { authHeaders, bootstrapAuth, hashParams, readCookie, secretFromHash, setSecret } from "../src/lib/auth";

function env(hash: string, cookie = "") {
  const calls: string[] = [];
  const store = new Map<string, string>();
  const doc = { cookie };
  return {
    calls,
    store,
    doc,
    e: {
      location: { hash, pathname: "/", search: "" },
      document: doc,
      history: { replaceState: (_d: unknown, _u: string, url?: string) => calls.push(url ?? "") },
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    },
  };
}

describe("auth bootstrap", () => {
  it("moves #k= into a strict cookie and strips the hash", () => {
    const t = env("#k=Ab3_x-9.secret");
    const r = bootstrapAuth(t.e);
    expect(r.secret).toBe("Ab3_x-9.secret");
    expect(t.doc.cookie).toBe("hpui=Ab3_x-9.secret; SameSite=Strict; path=/");
    expect(t.calls).toEqual(["/"]);
    expect(t.store.get("hpui")).toBe("Ab3_x-9.secret");
  });
  it("keeps other hash params (view=control)", () => {
    const t = env("#k=abc123&view=control");
    const r = bootstrapAuth(t.e);
    expect(r.params).toEqual({ view: "control" });
    expect(t.calls).toEqual(["/#view=control"]);
  });
  it("falls back to the cookie, then session storage, after a reload", () => {
    expect(bootstrapAuth(env("", "theme=x; hpui=from-cookie").e).secret).toBe("from-cookie");
    const t = env("");
    t.store.set("hpui", "from-storage");
    expect(bootstrapAuth(t.e).secret).toBe("from-storage");
    expect(bootstrapAuth(env("").e).secret).toBeUndefined();
  });
  it("rejects odd secrets", () => {
    expect(secretFromHash("#k=<script>")).toBeUndefined();
    expect(secretFromHash("#k=")).toBeUndefined();
    expect(secretFromHash("")).toBeUndefined();
    expect(hashParams("#k=a&x=1")).toEqual({ x: "1" });
    expect(readCookie("a=1; hpui=x%20y")).toBe("x y");
  });
  it("adds the x-hp-ui header once a secret is set", () => {
    setSecret(undefined);
    expect(authHeaders()).toEqual({});
    setSecret("s3");
    expect(authHeaders()).toEqual({ "x-hp-ui": "s3" });
  });
});
