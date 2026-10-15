import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initialViewFrom } from "./lib/view";
import { bootstrapAuth, setSecret } from "./lib/auth";
import "./styles.css";

let storage: Storage | null = null;
try {
  storage = window.sessionStorage;
} catch {
  storage = null;
}
const { secret, params } = bootstrapAuth({ location: window.location, document, history: window.history, storage });
setSecret(secret);

const initial = initialViewFrom(window.location.search, params);

createRoot(document.getElementById("root")!).render(<App initialView={initial} />);
