import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** GET a resource, optionally polling. */
export function useResource<T>(path: string, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>("GET", path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);
  return { data, error, reload, setData };
}

export interface ProfileRow { id: string; name: string; yaml: string }

export function ago(ts?: number) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

export function shortUA(ua: string) {
  if (/Silk|KF[A-Z]{2,}/i.test(ua)) return "Amazon Fire tablet";
  if (/iPad/i.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android device";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Mac OS X/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux PC";
  return ua.slice(0, 40) || "Unknown device";
}
