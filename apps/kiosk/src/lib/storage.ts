/** localStorage / sessionStorage that never throws (private mode, blocked storage, old WebViews). */
function make(kind: "localStorage" | "sessionStorage") {
  const memory = new Map<string, string>();
  const backend = (): Storage | null => {
    try {
      const s = (globalThis as any)[kind] as Storage | undefined;
      return s ?? null;
    } catch {
      return null;
    }
  };
  return {
    get(key: string): string | null {
      try {
        const s = backend();
        if (s) return s.getItem(key);
      } catch {
        /* fall through */
      }
      return memory.has(key) ? memory.get(key)! : null;
    },
    set(key: string, value: string) {
      memory.set(key, value);
      try {
        backend()?.setItem(key, value);
      } catch {
        /* memory only */
      }
    },
    remove(key: string) {
      memory.delete(key);
      try {
        backend()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export const local = make("localStorage");
export const session = make("sessionStorage");

export const TOKEN_KEY = "homepanel.deviceToken";
export const ADMIN_KEY = "homepanel.adminSession";
