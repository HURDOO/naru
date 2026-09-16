import { describe, expect, it } from "vitest";
import { readConfiguredAppBasePath, type AppBasePathMetaSource } from "./app-base-path";

describe("browser app base path metadata", () => {
  it("requires exactly one canonical metadata value", () => {
    expect(readConfiguredAppBasePath(metaSource("/naru"))).toBe("/naru");
    expect(readConfiguredAppBasePath(metaSource("/"))).toBe("/");
    expect(readConfiguredAppBasePath(metaSource())).toBeNull();
    expect(readConfiguredAppBasePath(metaSource("/naru", "/other"))).toBeNull();
    expect(readConfiguredAppBasePath(metaSource("/_gateway/apps"))).toBeNull();
    expect(readConfiguredAppBasePath(metaSource("/naru/"))).toBeNull();
  });
});

function metaSource(...values: readonly string[]): AppBasePathMetaSource {
  return {
    querySelectorAll: () =>
      values.map((value) => ({
        getAttribute: (name: string) => (name === "content" ? value : null),
      })),
  };
}
