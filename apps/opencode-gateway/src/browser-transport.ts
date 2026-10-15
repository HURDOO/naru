interface GatewaySession {
  readonly csrfToken: string;
  readonly session: { readonly browserOrigin: string };
}

interface GatewayProjectRoots {
  readonly version: 1;
  readonly defaultDirectory: string;
  readonly roots: readonly string[];
}

let projectRoots: GatewayProjectRoots | undefined;

export async function loadGatewayProjectRoots(
  fetch: typeof globalThis.fetch,
  url: string,
): Promise<void> {
  projectRoots = undefined;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Approved project folders are unavailable.");
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("defaultDirectory" in value) ||
    typeof value.defaultDirectory !== "string" ||
    !("roots" in value) ||
    !Array.isArray(value.roots) ||
    value.roots.length === 0 ||
    !value.roots.every(
      (root: unknown) => typeof root === "string" && absolutePath(root) === root,
    ) ||
    absolutePath(value.defaultDirectory) !== value.defaultDirectory ||
    !value.roots.some((root: string) => containsPath(root, value.defaultDirectory as string))
  )
    throw new Error("Invalid approved project folders.");
  projectRoots = value as GatewayProjectRoots;
}

export function gatewayProjectFolders(query = ""): readonly string[] {
  if (!projectRoots) return [];
  return [...new Set([projectRoots.defaultDirectory, ...projectRoots.roots])].filter((path) =>
    path.split("/").at(-1)?.toLowerCase().includes(query.toLowerCase()),
  );
}

export function gatewayProjectScope(
  value: string,
  home: string,
): { directory: string; path: string } | undefined {
  if (!projectRoots) return;
  const expanded = value.replace(/^~(?=\/|$)/, home);
  if (!expanded.startsWith("/")) return { directory: projectRoots.roots[0]!, path: expanded };
  const path = absolutePath(expanded);
  if (!path) return;
  const root = projectRoots.roots
    .filter((root) => containsPath(root, path))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return;
  return { directory: root, path: path.slice(root.length).replace(/^\//, "") };
}

export function gatewayProjectContains(directory: string): boolean {
  const path = absolutePath(directory);
  return !!path && !!projectRoots?.roots.some((root) => containsPath(root, path));
}

function containsPath(root: string, path: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : root + "/");
}

function absolutePath(value: string): string | undefined {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\")) return;
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return "/" + segments.join("/");
}

/** The upstream V2 client resolves absolute descriptors against baseUrl and drops its path. */
export function createPrefixedFetch(
  baseUrl: string,
  delegate: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  return (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base.origin) throw new Error("OpenCode API Origin changed.");
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      url.pathname = prefix + url.pathname;
    return delegate(new Request(url, request));
  };
}

export interface GatewayFetchOptions {
  readonly origin: string;
  readonly apiPrefix: string;
  readonly fetch: typeof globalThis.fetch;
  readonly authenticationRequired: () => void;
}

/** Keep Gateway credentials in memory and send them only to this app's exact API. */
export function createGatewayFetch(options: GatewayFetchOptions): {
  readonly fetch: typeof globalThis.fetch;
  readonly connect: () => Promise<void>;
} {
  let csrf: string | undefined;
  let connecting: Promise<void> | undefined;
  const connect = (): Promise<void> => {
    connecting ??= (async () => {
      const response = await options.fetch(`${options.origin}/_gateway/session`, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401) options.authenticationRequired();
      if (!response.ok) throw new Error("Gateway session is unavailable.");
      const value: unknown = await response.json();
      if (!isGatewaySession(value) || value.session.browserOrigin !== options.origin) {
        throw new Error("Gateway session does not match this Origin.");
      }
      csrf = value.csrfToken;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };
  const gatewayFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== options.origin ||
      !(url.pathname === options.apiPrefix || url.pathname.startsWith(`${options.apiPrefix}/`))
    ) {
      throw new Error("OpenCode must use its registered Gateway API.");
    }
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (unsafe && csrf === undefined) await connect();
    const send = (): Promise<Response> => {
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("x-workstation-gateway-assertion");
      headers.delete("x-workstation-gateway-csrf");
      if (unsafe && csrf !== undefined) headers.set("x-workstation-gateway-csrf", csrf);
      return options.fetch(
        new Request(request.clone(), {
          headers,
          credentials: "same-origin",
          redirect: "error",
        }),
      );
    };
    const response = await send();
    if (response.status === 401) {
      csrf = undefined;
      options.authenticationRequired();
    }
    if (unsafe && response.status === 403 && (await isCsrfDenial(response))) {
      // Gateway rejected this request before forwarding; retrying cannot duplicate a write.
      await connect();
      return send();
    }
    return response;
  };
  return { fetch: gatewayFetch, connect };
}

function isGatewaySession(value: unknown): value is GatewaySession {
  if (typeof value !== "object" || value === null) return false;
  if (!("csrfToken" in value) || typeof value.csrfToken !== "string" || !value.csrfToken)
    return false;
  if (!("session" in value) || typeof value.session !== "object" || value.session === null)
    return false;
  return "browserOrigin" in value.session && typeof value.session.browserOrigin === "string";
}

async function isCsrfDenial(response: Response): Promise<boolean> {
  try {
    const value: unknown = await response.clone().json();
    return (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "object" &&
      value.error !== null &&
      "code" in value.error &&
      value.error.code === "CSRF_DENIED"
    );
  } catch {
    return false;
  }
}
