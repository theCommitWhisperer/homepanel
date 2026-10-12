import { useEffect, useRef, useState } from "react";
import type { PairStartResponse, PairStatusResponse } from "@homepanel/protocol";
import { useNow } from "../components";
import { Icon } from "../icons";

export function Pairing({ onPaired, reason }: { onPaired: (token: string) => void; reason?: string | null }) {
  const [pair, setPair] = useState<PairStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(Date.now());
  const now = useNow(1000);
  const gen = useRef(0);

  const start = async () => {
    const my = ++gen.current;
    try {
      const r = await fetch("/api/pair/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const p = (await r.json()) as PairStartResponse;
      if (my !== gen.current) return;
      setPair(p);
      setStartedAt(Date.now());
      setError(null);
    } catch {
      if (my !== gen.current) return;
      setError("Can't reach the HomePanel server. Retrying…");
      setTimeout(() => my === gen.current && void start(), 4000);
    }
  };

  useEffect(() => {
    void start();
    return () => void gen.current++;
  }, []);

  useEffect(() => {
    if (!pair) return;
    let alive = true;
    const t = setInterval(async () => {
      if (Date.now() > pair.expiresAt) { clearInterval(t); void start(); return; }
      try {
        const r = await fetch("/api/pair/status/" + encodeURIComponent(pair.pairingId));
        if (!alive) return;
        if (r.status === 404) { clearInterval(t); void start(); return; }
        if (!r.ok) return;
        const s = (await r.json()) as PairStatusResponse;
        if (!alive) return;
        if (s.status === "approved") { clearInterval(t); onPaired(s.deviceToken); }
        else if (s.status === "expired" || s.status === "rejected") {
          clearInterval(t);
          if (s.status === "rejected") setError("That code was rejected. Here's a new one.");
          void start();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [pair]);

  const total = pair ? Math.max(1, pair.expiresAt - startedAt) : 1;
  const left = pair ? Math.max(0, pair.expiresAt - now) : 0;
  const code = pair?.code ?? "······";
  return (
    <div className="center-screen pairing">
      <div className="brand"><Icon name="logo" size={30} /> HomePanel</div>
      <div className="pair-code num" aria-label={"Pairing code " + code.split("").join(" ")}>
        {code.slice(0, 3).split("").map((c, i) => <span key={i}>{c}</span>)}
        <span className="gap" />
        {code.slice(3).split("").map((c, i) => <span key={i + 3}>{c}</span>)}
      </div>
      <div className="pair-hint">
        Approve this screen in HomePanel admin
        <span className="pair-url">{location.origin}/admin</span>
      </div>
      {pair && (
        <>
          <div className="pair-bar"><div style={{ width: (left / total) * 100 + "%" }} /></div>
          <div className="pair-meta num">New code in {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}</div>
        </>
      )}
      {(error || reason) && <div className="pair-error">{error ?? reason}</div>}
    </div>
  );
}
