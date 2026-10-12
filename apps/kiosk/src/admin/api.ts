import { ADMIN_KEY, session } from "../lib/storage";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export const adminSession = {
  get: () => session.get(ADMIN_KEY),
  set: (s: string | null) => (s ? session.set(ADMIN_KEY, s) : session.remove(ADMIN_KEY)),
};

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(f: () => void) {
  onUnauthorized = f;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
  const headers: Record<string, string> = {};
  const tok = adminSession.get();
  if (tok) headers.Authorization = "Bearer " + tok;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = contentType;
    payload = contentType === "application/json" ? JSON.stringify(body) : (body as string);
  }
  let r: Response;
  try {
    r = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Can't reach the HomePanel server.");
  }
  const text = await r.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (r.status === 401 && !path.endsWith("/login")) {
    adminSession.set(null);
    onUnauthorized();
  }
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || r.statusText || "Request failed";
    throw new ApiError(r.status, String(msg), data);
  }
  return data as T;
}
