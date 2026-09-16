export const NARU_APP_BASE_PATH_CONTRACT_VERSION = 1 as const;
export const NARU_LEGACY_APP_BASE_PATH = "/" as const;
export const NARU_DEFAULT_APP_BASE_PATH = "/naru" as const;
export const NARU_APP_BASE_PATH_META_NAME = "naru-app-base-path" as const;

export type NaruAppBasePath = string;

export function parseNaruAppBasePath(value: unknown): NaruAppBasePath {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    throw new Error("Naru app base path must be one canonical absolute path.");
  }
  if (value === NARU_LEGACY_APP_BASE_PATH) return value;
  if (!/^\/(?:[A-Za-z0-9][A-Za-z0-9._~-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/.test(value)) {
    throw new Error(
      "Naru app base path must contain canonical unescaped path segments without a trailing slash.",
    );
  }
  if (value === "/_gateway" || value.startsWith("/_gateway/")) {
    throw new Error("Naru app base path must not use the reserved Gateway route prefix.");
  }
  return value;
}

export function naruAppPath(basePath: NaruAppBasePath, pathname: string): string {
  const canonicalBasePath = parseNaruAppBasePath(basePath);
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("#") ||
    pathname.includes("\\")
  ) {
    throw new Error("Naru application pathname must be a same-origin absolute path.");
  }
  const parsed = new URL(pathname, "https://naru.invalid");
  if (parsed.origin !== "https://naru.invalid" || parsed.hash !== "") {
    throw new Error("Naru application pathname must remain same-origin.");
  }
  const suffix = `${parsed.pathname}${parsed.search}`;
  return canonicalBasePath === "/" ? suffix : `${canonicalBasePath}${suffix}`;
}

export function naruAppScopePath(basePath: NaruAppBasePath): string {
  const canonicalBasePath = parseNaruAppBasePath(basePath);
  return canonicalBasePath === "/" ? "/" : `${canonicalBasePath}/`;
}

export function isNaruAppPath(basePath: NaruAppBasePath, pathname: string): boolean {
  const canonicalBasePath = parseNaruAppBasePath(basePath);
  return (
    canonicalBasePath === "/" ||
    pathname === canonicalBasePath ||
    pathname.startsWith(`${canonicalBasePath}/`)
  );
}
