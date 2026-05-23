import { describe, it, expect } from "vitest";
import { TOOLS, HANDLERS } from "../src/tools.js";

describe("TOOLS ↔ HANDLERS symmetry", () => {
  it("every tool name has a handler", () => {
    const toolNames = TOOLS.map((t) => t.name).sort();
    const handlerNames = Object.keys(HANDLERS).sort();
    expect(handlerNames).toEqual(toolNames);
  });
});
