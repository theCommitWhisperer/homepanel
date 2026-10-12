import { createRoot } from "react-dom/client";
import "./styles.css";
import "./widgets.css";
import { local, TOKEN_KEY } from "./lib/storage";
import { KioskApp } from "./kiosk/KioskApp";
import { lazy, Suspense } from "react";

const AdminApp = lazy(() => import("./admin/AdminApp").then((m) => ({ default: m.AdminApp })));

// Dev convenience: ?token=demo stores the device token, then strips it from the URL.
try {
  const params = new URLSearchParams(location.search);
  const t = params.get("token");
  if (t) {
    local.set(TOKEN_KEY, t);
    params.delete("token");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
  }
} catch {
  /* ignore */
}

const isAdmin = /^\/admin(\/|$)/.test(location.pathname);
document.documentElement.classList.toggle("admin-mode", isAdmin);

createRoot(document.getElementById("root")!).render(
  isAdmin ? (
    <Suspense fallback={null}>
      <AdminApp />
    </Suspense>
  ) : (
    <KioskApp />
  ),
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
