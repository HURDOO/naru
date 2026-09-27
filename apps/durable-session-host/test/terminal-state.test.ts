import { describe, expect, it } from "vitest";
import { BoundedTerminalState } from "../src/terminal-state.js";
import { TEST_IDS } from "./support.js";

describe("DurableSession Host bounded terminal state", () => {
  it("keeps canonical state and sequence with zero attachments, including alternate screen", async () => {
    const terminal = new BoundedTerminalState(
      TEST_IDS.session1,
      TEST_IDS.runtime1,
      { cols: 80, rows: 24 },
      { scrollbackRows: 100, outputRingCharacters: 128 * 1_024 },
    );
    await terminal.recordOutput("before\r\n", 1);
    await terminal.recordOutput("\u001b[?1049hALT-SCREEN\u001b[?1049l", 2);
    const snapshot = await terminal.snapshot();

    expect(snapshot).toMatchObject({
      runtimeId: TEST_IDS.runtime1,
      sequence: 2,
      terminal: { cols: 80, rows: 24 },
    });
    expect(snapshot.serializedState).toContain("before");
    terminal.dispose();
  });

  it("restores mouse encoding through a split output, reconnect, disable, and terminal reset", async () => {
    const terminal = new BoundedTerminalState(
      TEST_IDS.session1,
      TEST_IDS.runtime1,
      { cols: 80, rows: 24 },
      { scrollbackRows: 100, outputRingCharacters: 128 * 1_024 },
    );
    await terminal.recordOutput("\u001b[?1049h\u001b[?1003;10", 1);
    await terminal.recordOutput("06hFULLSCREEN", 2);
    expect((await terminal.snapshot()).serializedState).toContain("\u001b[?1006h");
    await terminal.recordOutput("\u001b[?1016h", 3);
    expect((await terminal.snapshot()).serializedState).toContain("\u001b[?1016h");
    await terminal.recordOutput("\u001b[?1016l", 4);
    expect((await terminal.snapshot()).serializedState).not.toContain("\u001b[?1016h");
    await terminal.recordOutput("\u001bc", 5);
    expect((await terminal.snapshot()).serializedState).not.toContain("\u001b[?1006h");
    terminal.dispose();
  });

  it("bounds the output ring and reports when an old cursor requires resync", async () => {
    const terminal = new BoundedTerminalState(
      TEST_IDS.session1,
      TEST_IDS.runtime1,
      { cols: 20, rows: 5 },
      { scrollbackRows: 2, outputRingCharacters: 8 },
    );
    await terminal.recordOutput("aaaa", 1);
    await terminal.recordOutput("bbbb", 2);
    await terminal.recordOutput("cccc", 3);

    expect(await terminal.readAfter(0)).toBeNull();
    expect(await terminal.readAfter(1)).toEqual([
      { runtimeId: TEST_IDS.runtime1, sequence: 2, data: "bbbb" },
      { runtimeId: TEST_IDS.runtime1, sequence: 3, data: "cccc" },
    ]);
    terminal.dispose();
  });
});
