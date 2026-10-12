import "./lib/bootstrap"; // must stay first: stores ?token= before the connection is created
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./widgets.css";
import { KioskApp } from "./kiosk/KioskApp";
import { lazy, Suspense } from "react";

const AdminApp = lazy(() => import("./admin/AdminApp").then((m) => ({ default: m.AdminApp })));

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
