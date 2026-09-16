import { describe, expect, it } from "vitest";
import { isNaruAppPath, naruAppPath, naruAppScopePath, parseNaruAppBasePath } from "./index.js";

describe("Naru app base path v1", () => {
  it.each(["/", "/naru", "/team/naru-2", "/Naru_v1"])("accepts %s", (value) => {
    expect(parseNaruAppBasePath(value)).toBe(value);
  });

  it.each([
    "",
    "naru",
    "/naru/",
    "//naru",
    "/naru//app",
    "/./naru",
    "/../naru",
    "/naru/..",
    "/naru?mode=pwa",
    "/naru#app",
    "/naru%2fother",
    "/_gateway",
    "/_gateway/apps",
  ])("rejects non-canonical or reserved value %s", (value) => {
    expect(() => parseNaruAppBasePath(value)).toThrow();
  });

  it("joins app-owned paths and scopes without changing legacy root behavior", () => {
    expect(naruAppPath("/", "/api/session")).toBe("/api/session");
    expect(naruAppPath("/naru", "/api/session")).toBe("/naru/api/session");
    expect(naruAppScopePath("/")).toBe("/");
    expect(naruAppScopePath("/naru")).toBe("/naru/");
    expect(isNaruAppPath("/naru", "/naru/projects")).toBe(true);
    expect(isNaruAppPath("/naru", "/other/projects")).toBe(false);
  });
});
