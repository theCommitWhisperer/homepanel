import { describe, expect, it } from "vitest";
import { emptyRun, INTRO, replay, setupReducer, doneCount, fmtDuration, isStepHeading } from "../src/lib/setup";
import type { SetupEvent } from "../src/lib/types";

const RUN: SetupEvent[] = [
  { type: "run", runId: "r1", mode: "host", state: "running" },
  { type: "steps", steps: [{ id: "lhm", title: "LibreHardwareMonitor", summary: "Reads temps" }, { id: "mosquitto", title: "Mosquitto MQTT broker" }, { id: "agent", title: "Run the agent" }] },
  { type: "log", level: "heading", text: "Host HomePanel on this PC" },
  { type: "log", level: "steps", text: "a\nb", items: ["LibreHardwareMonitor", "Mosquitto MQTT broker"] },
  { type: "question", id: "q1", kind: "select", message: "How do you want to go?", choices: [{ value: "ask", name: "Ask" }, { value: "all", name: "All" }] },
  { type: "answered", id: "q1" },
  { type: "step", id: "lhm", state: "checking" },
  { type: "log", level: "ok", text: "Found LibreHardwareMonitor.exe" },
  { type: "step", id: "lhm", state: "done", detail: "Found" },
  { type: "step", id: "mosquitto", state: "checking" },
  { type: "log", level: "code", text: "winget install --id EclipseFoundation.Mosquitto -e" },
  { type: "question", id: "q2", kind: "confirm", message: "Do this now?", default: false },
  { type: "answered", id: "q2" },
  { type: "step", id: "mosquitto", state: "running" },
  { type: "progress", label: "Downloading", pct: 40 },
  { type: "ai", role: "assistant", text: "Installing Mosquitto" },
];

describe("setup event reducer", () => {
  it("builds steps, per-step logs, questions and progress", () => {
    const s = replay(RUN);
    expect(s.runId).toBe("r1");
    expect(s.state).toBe("running");
    expect(s.steps.map((x) => x.state)).toEqual(["done", "running", "pending"]);
    expect(s.steps[0]).toMatchObject({ summary: "Reads temps", detail: "Found" });
    expect(s.current).toBe("mosquitto");
    expect(s.logs[INTRO]!.map((l) => l.level)).toEqual(["heading", "steps"]);
    expect(s.logs[INTRO]![1]!.items).toHaveLength(2);
    expect(s.logs.lhm!.map((l) => l.text)).toEqual(["Found LibreHardwareMonitor.exe"]);
    expect(s.logs.mosquitto![0]!.level).toBe("code");
    expect(s.question).toBeUndefined();
    expect(s.progress.mosquitto).toEqual({ label: "Downloading", pct: 40 });
    expect(s.ai).toEqual([{ role: "assistant", text: "Installing Mosquitto" }]);
    expect(doneCount(s)).toBe(1);
  });

  it("keeps a pending question with the step it belongs to and attaches validation errors", () => {
    let s = replay([...RUN, { type: "question", id: "q3", kind: "password", message: "Admin password (hidden):" }]);
    expect(s.question).toMatchObject({ id: "q3", at: "mosquitto" });
    s = setupReducer(s, { type: "event", event: { type: "question_error", id: "q3", error: "At least 6 characters" } });
    expect(s.question?.error).toBe("At least 6 characters");
    // errors / answers for another question id are ignored
    s = setupReducer(s, { type: "event", event: { type: "answered", id: "zzz" } });
    expect(s.question?.id).toBe("q3");
    s = setupReducer(s, { type: "event", event: { type: "answered", id: "q3" } });
    expect(s.question).toBeUndefined();
  });

  it("clears progress when the step finishes and drops the question when the run ends", () => {
    let s = replay([...RUN, { type: "question", id: "q9", kind: "confirm", message: "?" }, { type: "step", id: "mosquitto", state: "failed", detail: "exit 1" }]);
    expect(s.progress.mosquitto).toBeUndefined();
    expect(s.steps[1]).toMatchObject({ state: "failed", detail: "exit 1" });
    s = setupReducer(s, { type: "event", event: { type: "run", runId: "r1", mode: "host", state: "cancelled" } });
    expect(s.state).toBe("cancelled");
    expect(s.question).toBeUndefined();
  });

  it("replaying the history after a reconnect gives the same state", () => {
    const live = RUN.reduce((st, e) => setupReducer(st, { type: "event", event: e }), emptyRun);
    let s = setupReducer(live, { type: "reset" });
    expect(s).toEqual(emptyRun);
    for (const e of RUN) s = setupReducer(s, { type: "event", event: e });
    expect(s).toEqual(live);
  });

  it("a new runId starts from scratch", () => {
    const s = setupReducer(replay(RUN), { type: "event", event: { type: "run", runId: "r2", mode: "ha", state: "running" } });
    expect(s).toMatchObject({ runId: "r2", mode: "ha", steps: [], logs: {}, ai: [] });
  });

  it("uses server timestamps for step durations, and tracks the summary", () => {
    const ev = (e: object) => ({ type: "event" as const, event: e as SetupEvent, at: 999999 });
    let s = setupReducer(emptyRun, ev({ type: "steps", steps: [{ id: "a", title: "A" }] }));
    s = setupReducer(s, ev({ type: "step", id: "a", state: "checking", ts: 1000 }));
    s = setupReducer(s, ev({ type: "step", id: "a", state: "running", ts: 2000 }));
    s = setupReducer(s, ev({ type: "step", id: "a", state: "done", ts: 6500 }));
    expect(s.steps[0]).toMatchObject({ startedAt: 1000, endedAt: 6500 });
    s = setupReducer(s, ev({ type: "summary", items: [{ label: "Admin password", value: "x", secret: true }] }));
    expect(s.summary?.[0]?.secret).toBe(true);
    // an unknown step id from the server still shows up
    s = setupReducer(s, ev({ type: "step", id: "tray", state: "running" }));
    expect(s.steps.at(-1)).toMatchObject({ id: "tray", title: "tray" });
  });

  it("local AI messages are added as the user's", () => {
    expect(setupReducer(emptyRun, { type: "local-ai", text: "why?" }).ai).toEqual([{ role: "user", text: "why?" }]);
  });

  it("helpers", () => {
    expect(fmtDuration(400)).toBe("<1 s");
    expect(fmtDuration(42_000)).toBe("42 s");
    expect(fmtDuration(125_000)).toBe("2 min 05 s");
    expect(isStepHeading("3/13  Mosquitto MQTT broker")).toBe(true);
    expect(isStepHeading("Summary")).toBe(false);
  });
});

describe("questions that arrive before their step starts", () => {
  it("make the question's step current, so its logs land there", () => {
    let s = replay([
      { type: "run", runId: "r", mode: "ha", state: "running" },
      { type: "steps", steps: [{ id: "token", title: "Token" }, { id: "mqtt", title: "MQTT" }] },
      { type: "step", id: "token", state: "done" },
      { type: "question", id: "q", kind: "select", message: "MQTT: do it?", stepId: "mqtt", choices: [{ value: "do", name: "Do it" }] },
    ]);
    expect(s.current).toBe("mqtt");
    s = setupReducer(s, { type: "event", event: { type: "log", level: "info", text: "Installing…" } });
    expect(s.logs.mqtt?.[0]?.text).toBe("Installing…");
  });
  it("prefixed step ids (host.agent) are just ids", () => {
    const s = replay([
      { type: "steps", steps: [{ id: "host.agent", title: "Agent" }] },
      { type: "step", id: "host.agent", state: "running" },
      { type: "progress", stepId: "host.agent", label: "Waiting" },
    ]);
    expect(s.current).toBe("host.agent");
    expect(s.progress["host.agent"]?.label).toBe("Waiting");
  });
});
