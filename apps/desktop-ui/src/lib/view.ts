export type View = "check" | "modes" | "run" | "control";

/** Map an opener/server view name (?view=setup|control, {type:"show", view}) to a screen. */
export function viewFrom(v: string | null | undefined): View | undefined {
  switch ((v ?? "").toLowerCase()) {
    case "control":
      return "control";
    case "setup":
    case "check":
      return "check";
    case "modes":
      return "modes";
    case "run":
      return "run";
    default:
      return undefined;
  }
}

/** ?view= in the query wins over #view= in the hash. */
export function initialViewFrom(search: string, hashParams: Record<string, string>): View | undefined {
  return viewFrom(new URLSearchParams(search).get("view")) ?? viewFrom(hashParams.view);
}
