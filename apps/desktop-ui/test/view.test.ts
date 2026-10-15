import { describe, expect, it } from "vitest";
import { initialViewFrom, viewFrom } from "../src/lib/view";

describe("initial view", () => {
  it("maps server/opener names to screens", () => {
    expect(viewFrom("setup")).toBe("check");
    expect(viewFrom("control")).toBe("control");
    expect(viewFrom("nope")).toBeUndefined();
    expect(viewFrom(undefined)).toBeUndefined();
  });
  it("query wins over hash", () => {
    expect(initialViewFrom("?view=control", { view: "setup" })).toBe("control");
    expect(initialViewFrom("", { view: "control" })).toBe("control");
    expect(initialViewFrom("?x=1", {})).toBeUndefined();
  });
});
