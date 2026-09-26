import { describe, expect, it } from "vitest";

import fixture from "./chatWire.fixture.json";
import { CHAT_WIRE_VERSION, ChatWireDecoder, ChatWireGap, applyObject } from "./chatWire";

// The fixture is written by the Rust encoder test (`web::chat_wire::tests`), so decoding it here pins the
// TypeScript decoder to exactly what the server sends.
describe("chat wire decoder", () => {
  it("decodes every frame the Rust encoder produced back to the engine's payload", () => {
    expect(fixture.version).toBe(CHAT_WIRE_VERSION);
    const decoder = new ChatWireDecoder();
    for (const frame of fixture.frames) {
      const sid = frame.name.slice("chat://event/".length);
      expect(decoder.decode(sid, frame.payload)).toEqual(frame.decoded);
    }
  });

  it("never mutates what it handed out before", () => {
    const decoder = new ChatWireDecoder();
    const first = decoder.decode("s", { type: "rows", epoch: 1, retain: ["r"], rows: [{ kind: "assistant", id: "r", text: "a", streaming: true, meta: { n: 1 } }] }) as { rows: object[] };
    const frozen = JSON.parse(JSON.stringify(first));
    const second = decoder.decode("s", { type: "rows", epoch: 1, retain: ["r"], rows: [{ id: "r", patch: { app: { text: "b" }, len: { text: 1 }, sub: { meta: { set: { n: 2 } } } } }] }) as { rows: Array<Record<string, unknown>> };
    expect(first).toEqual(frozen);
    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(second.rows[0]).toEqual({ kind: "assistant", id: "r", text: "ab", streaming: true, meta: { n: 2 } });
    expect(second).not.toHaveProperty("retain");
  });

  it("keeps exactly the retained rows as bases", () => {
    const decoder = new ChatWireDecoder();
    decoder.decode("s", { type: "rows", epoch: 1, rows: [{ kind: "tool", id: "t", status: "completed" }] });
    expect(() => decoder.decode("s", { type: "rows", epoch: 1, rows: [{ id: "t", patch: { set: { status: "failed" } } }] })).toThrow(ChatWireGap);
    decoder.decode("s", { type: "rows", epoch: 1, retain: ["t"], rows: [{ kind: "tool", id: "t", status: "running" }] });
    // A new epoch drops every base.
    expect(() => decoder.decode("s", { type: "rows", epoch: 2, rows: [{ id: "t", patch: { set: { status: "failed" } } }] })).toThrow(ChatWireGap);
  });

  it("treats a tampered append length or a missing base as a gap", () => {
    expect(() => applyObject({ text: "héllo" }, { app: { text: "!" }, len: { text: 4 } })).toThrow(ChatWireGap);
    expect(applyObject({ text: "😀" }, { app: { text: "!" }, len: { text: 2 } })).toEqual({ text: "😀!" });
    const decoder = new ChatWireDecoder();
    expect(() => decoder.decode("s", { type: "extras", patch: { set: { fastMode: true } } })).toThrow(ChatWireGap);
    expect(() => applyObject({ list: [{ id: "a" }] }, { arr: { list: { key: "id", order: ["a", "b"] } } })).toThrow(ChatWireGap);
  });

  it("passes the full frames of an older server through unchanged", () => {
    const decoder = new ChatWireDecoder();
    const rows = { type: "rows", epoch: 1, revision: 2, rows: [{ kind: "user", id: "u", text: "hi" }] };
    const extras = { type: "extras", extras: { fastMode: false, backgroundTasks: [{ task_id: "t", workflow_progress: [] }] } };
    const queued = { type: "queued", items: [] };
    expect(decoder.decode("s", rows)).toEqual(rows);
    expect(decoder.decode("s", extras)).toBe(extras);
    expect(decoder.decode("s", queued)).toBe(queued);
  });
});
