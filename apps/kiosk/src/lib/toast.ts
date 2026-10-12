export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
}
let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const toastStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => toasts,
};

export function toast(text: string, kind: Toast["kind"] = "info", ms = 3500) {
  const t = { id: ++seq, kind, text };
  toasts = toasts.concat(t).slice(-3);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, ms);
}
