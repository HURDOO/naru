import { readFileSync, writeFileSync, copyFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";

// Input is the official v1.18.35 archive extracted into a separate build directory.
const root = realpathSync(process.argv[2] ?? "");
const app = join(root, "packages/app");
const rootMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (rootMetadata.workspaces?.catalog) {
  const catalog = rootMetadata.workspaces.catalog;
  const packages = ["app", "ui", "schema", "core", "session-ui", "sdk/js"];
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "opencode-gateway-ui-build",
        private: true,
        type: "module",
        packageManager: "pnpm@11.12.0",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n" +
      packages.map((name) => "  - packages/" + name + "\n").join("") +
      "allowBuilds:\n  esbuild: true\n  '@tailwindcss/oxide': true\n",
  );
  for (const name of packages) {
    const filename = join(root, "packages", name, "package.json");
    const value = JSON.parse(readFileSync(filename, "utf8"));
    // App imports only Core's browser-safe util modules; provisioning its backend is unnecessary.
    if (name === "core") {
      value.dependencies = {};
      value.devDependencies = {};
      value.scripts = {};
    }
    for (const section of ["dependencies", "devDependencies"])
      for (const [key, version] of Object.entries(value[section] ?? {})) {
        if (version === "catalog:") value[section][key] = catalog[key];
      }
    writeFileSync(filename, JSON.stringify(value, null, 2) + "\n");
  }
}
const metadata = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
if (metadata.version !== "1.18.35") throw new Error("OpenCode UI version does not match.");
const entryPath = join(app, "src/entry.tsx");
let entry = readFileSync(entryPath, "utf8");
function replace(before, after) {
  if (!entry.includes(before)) throw new Error("Upstream UI integration point changed.");
  entry = entry.replace(before, after);
}
replace(
  'import { render } from "solid-js/web"',
  'import { render } from "solid-js/web"\nimport { Router } from "@solidjs/router"\nimport { createGatewayFetch, loadGatewayProjectRoots } from "./naru-gateway-transport"',
);
replace("  return location.origin\n}", "  return `${location.origin}/omo/api`\n}");
replace(
  "  if (lsDefault) return lsDefault",
  "  if (lsDefault === `${location.origin}/omo/api`) return lsDefault",
);
replace(
  "const platform: Platform = {",
  `const gateway = createGatewayFetch({
  origin: location.origin,
  apiPrefix: "/omo/api",
  fetch: globalThis.fetch.bind(globalThis),
  authenticationRequired: () => {
    location.assign("/_gateway/login?returnTo=" + encodeURIComponent(location.pathname + location.search))
  },
})
const platform: Platform = {
  fetch: gateway.fetch,`,
);
replace(
  "              disableHealthCheck\n",
  '              disableHealthCheck\n              startup={gateway.connect().then(() => loadGatewayProjectRoots(gateway.fetch, location.origin + "/omo/api/_naru/project-roots"))}\n              router={(props) => <Router {...props} base="/omo" />}\n',
);
writeFileSync(entryPath, entry);
// Router base prefixes URLs, but upstream route classifiers expect root-relative
// useLocation().pathname. Keep those classifiers consistent with /omo routing.
writeFileSync(
  join(app, "src/naru-gateway-router.ts"),
  `import { useLocation as useRouterLocation } from "@solidjs/router"
export function useLocation(): ReturnType<typeof useRouterLocation> {
  const location = useRouterLocation()
  return new Proxy(location, {
    get(target, property, receiver) {
      if (property === "pathname") return target.pathname.replace(/^\\/omo(?=\\/|$)/, "") || "/"
      return Reflect.get(target, property, receiver)
    },
  })
}
`,
);
for (const name of [
  "context/tabs.tsx",
  "context/layout.tsx",
  "components/titlebar.tsx",
  "pages/directory-layout.tsx",
  "pages/session/use-session-hash-scroll.ts",
  "components/debug-bar.tsx",
]) {
  const filename = join(app, "src", name);
  const source = readFileSync(filename, "utf8");
  const importPattern = /import \{([^}]+)\} from "@solidjs\/router"/;
  const match = source.match(importPattern);
  if (!match || !/\buseLocation\b/.test(match[1]))
    throw new Error("Upstream route location changed.");
  writeFileSync(
    filename,
    'import { useLocation } from "@/naru-gateway-router"\n' +
      source.replace(
        importPattern,
        (_, names) =>
          "import {" + names.replace(/\buseLocation\s*,?\s*/, "") + '} from "@solidjs/router"',
      ),
  );
}
const tabNavPath = join(app, "src/components/titlebar-tab-nav.tsx");
const tabNav = readFileSync(tabNavPath, "utf8");
if (tabNav.match(/href=\{props.href\}/g)?.length !== 2)
  throw new Error("Upstream tab links changed.");
writeFileSync(tabNavPath, tabNav.replaceAll("href={props.href}", 'href={"/omo" + props.href}'));
const commandPath = join(app, "src/context/command.tsx");
const command = readFileSync(commandPath, "utf8");
if (!command.includes("      const options = createMemo(next)"))
  throw new Error("Upstream command registration changed.");
writeFileSync(
  commandPath,
  command.replace(
    "      const options = createMemo(next)",
    "      const options = createMemo(next, [])",
  ),
);
const titlebarPath = join(app, "src/components/titlebar.tsx");
let titlebar = readFileSync(titlebarPath, "utf8");
for (const [before, after] of [
  [
    'import { normalizeSessionInfo } from "@/utils/session"',
    'import { normalizeSessionInfo } from "@/utils/session"\nimport { useDirectoryPicker } from "./directory-picker"',
  ],
  [
    "  const layout = useLayout()\n  const platform",
    "  const layout = useLayout()\n  const pickDirectory = useDirectoryPicker()\n  const platform",
  ],
  [
    "              if (!fallback) return",
    `              if (!fallback) {
                const conn = server.current
                if (!conn) return
                pickDirectory({ server: conn, onSelect: (directory) => {
                  if (typeof directory !== "string") return
                  const ctx = global.ensureServerCtx(conn)
                  ctx.projects.open(directory)
                  ctx.projects.touch(directory)
                  void tabs.newDraft({ server: ServerConnection.key(conn), directory })
                } })
                return
              }`,
  ],
]) {
  if (!titlebar.includes(before)) throw new Error("Upstream new-tab project selection changed.");
  titlebar = titlebar.replace(before, after);
}
writeFileSync(titlebarPath, titlebar);
const directoryPath = join(app, "src/components/directory-picker-domain.ts");
let directory = readFileSync(directoryPath, "utf8");
const scopeStart = directory.indexOf("  const scoped = (value: string) => {");
const scopeEnd = directory.indexOf(
  "  const directories = async (directory: string) => {",
  scopeStart,
);
if (scopeStart < 0 || scopeEnd < 0) throw new Error("Upstream directory picker changed.");
directory =
  directory.slice(0, scopeStart) +
  "  const scoped = (value: string) => gatewayProjectScope(normalizePickerDrive(value), args.home())\n\n" +
  directory.slice(scopeEnd);
function replaceDirectory(before, after) {
  if (!directory.includes(before))
    throw new Error("Upstream directory picker integration changed.");
  directory = directory.replace(before, after);
}
replaceDirectory(
  "    const key = trimPickerPath(directory)\n    const existing = cache.get(key)",
  "    const key = trimPickerPath(directory)\n    if (!gatewayProjectContains(key)) return []\n    const existing = cache.get(key)",
);
replaceDirectory(
  "        return results.map((path) => joinPickerPath(input.directory, path)).slice(0, 50)",
  "        return [...gatewayProjectFolders(value), ...results.map((path) => joinPickerPath(input.directory, path))].slice(0, 50)",
);
replaceDirectory(
  "      return fallback\n    }\n    const segments",
  "      return [...gatewayProjectFolders(value), ...fallback]\n    }\n    const segments",
);
replaceDirectory(
  '    const base = raw.startsWith("~") ? trimPickerPath(input.directory) : ""',
  '    const base = !query || raw.startsWith("~") ? trimPickerPath(input.directory) : ""',
);
writeFileSync(
  directoryPath,
  'import { gatewayProjectScope, gatewayProjectContains, gatewayProjectFolders } from "../naru-gateway-transport"\n' +
    directory,
);
const protocolPath = join(app, "src/utils/server-protocol.ts");
const protocol = readFileSync(protocolPath, "utf8");
if (!protocol.includes("new URL(path, server.url)"))
  throw new Error("Upstream protocol probe changed.");
writeFileSync(
  protocolPath,
  protocol.replace("new URL(path, server.url)", 'new URL(server.url.replace(/\\/$/, "") + path)'),
);
const sdkPath = join(app, "src/context/server-sdk.tsx");
const sdk = readFileSync(sdkPath, "utf8");
const eventFetchStart = sdk.indexOf("  const eventFetch = (() => {");
const eventFetchEnd = sdk.indexOf("  })()", eventFetchStart);
if (eventFetchStart < 0 || eventFetchEnd < 0) throw new Error("Upstream event transport changed.");
writeFileSync(
  sdkPath,
  sdk.slice(0, eventFetchStart) +
    "  const eventFetch = platform.fetch" +
    sdk.slice(eventFetchEnd + 6),
);
// New draft routes mount during a Solid transition. Seed their context accessors
// synchronously so dependent provider/model hooks cannot read an undefined context.
for (const [name, type, field] of [
  ["server-sdk", "ServerSDK", "sdk"],
  ["server-sync", "ServerSync", "sync"],
]) {
  const filename = join(app, `src/context/${name}.tsx`);
  const source = readFileSync(filename, "utf8");
  const before = `    return createMemo<${type}>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).${field}
    })`;
  const after = `    const resolve = () => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).${field}
    }
    return createMemo<${type}>(resolve, resolve())`;
  if (!source.includes(before)) throw new Error("Upstream draft context integration changed.");
  writeFileSync(filename, source.replace(before, after));
}
const directorySdkPath = join(app, "src/context/sdk.tsx");
const directorySdk = readFileSync(directorySdkPath, "utf8");
const directorySdkBefore = `    return createMemo(() => {
      const directory = typeof props.directory === "function" ? props.directory() : props.directory
      return serverSDK().ensureDirSdkContext(directory)
    })`;
if (!directorySdk.includes(directorySdkBefore))
  throw new Error("Upstream directory context changed.");
writeFileSync(
  directorySdkPath,
  directorySdk.replace(
    directorySdkBefore,
    `    const resolve = () => {
      const directory = typeof props.directory === "function" ? props.directory() : props.directory
      return serverSDK().ensureDirSdkContext(directory)
    }
    return createMemo(resolve, resolve())`,
  ),
);
const directorySyncPath = join(app, "src/context/sync.tsx");
const directorySync = readFileSync(directorySyncPath, "utf8");
const directorySyncBefore =
  "  return createMemo(() => serverSync().ensureDirSyncContext(sdk().directory))";
if (!directorySync.includes(directorySyncBefore))
  throw new Error("Upstream directory sync changed.");
writeFileSync(
  directorySyncPath,
  directorySync.replace(
    directorySyncBefore,
    "  const resolve = () => serverSync().ensureDirSyncContext(sdk().directory)\n  return createMemo(resolve, resolve())",
  ),
);
// The parent TargetServerRoute already validates and keys the server identity.
// Route params can disappear while the old subtree is being disposed; retain
// that validated provider identity instead of re-decoding an expired param.
const sessionPagePath = join(app, "src/pages/session.tsx");
let sessionPage = readFileSync(sessionPagePath, "utf8");
for (const [before, after] of [
  [
    "  const directory = createMemo(() => serverSync().session.lineage.peek(params.id)?.session.directory)",
    "  const targetServerKey = ServerConnection.key(useServerSDK()().server)\n  const directory = createMemo(() => serverSync().session.lineage.peek(params.id)?.session.directory)",
  ],
  ["serverKey={requireServerKey(params.serverKey)} padded", "serverKey={targetServerKey} padded"],
  [
    "  const serverKey = createMemo(() => requireServerKey(params.serverKey))",
    "  const targetServerKey = ServerConnection.key(useServerSDK()().server)\n  const serverKey = () => targetServerKey",
  ],
]) {
  if (!sessionPage.includes(before)) throw new Error("Upstream target session identity changed.");
  sessionPage = sessionPage.replace(before, after);
}
writeFileSync(sessionPagePath, sessionPage);
const sessionLayoutPath = join(app, "src/pages/session/session-layout.ts");
let sessionLayout = readFileSync(sessionLayoutPath, "utf8");
for (const [before, after] of [
  [
    "  const scope = createMemo(() => serverSDK().scope)",
    "  const scope = createMemo(() => serverSDK().scope, serverSDK().scope)",
  ],
  [
    "  const directory = createMemo(() => base64Encode(sdk().directory))",
    "  const directory = createMemo(() => base64Encode(sdk().directory), base64Encode(sdk().directory))",
  ],
  [
    "  const workspaceKey = createMemo(() => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory())))",
    "  const resolveWorkspace = () => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory()))\n  const workspaceKey = createMemo(resolveWorkspace, resolveWorkspace())",
  ],
  [
    "  const sessionKey = createMemo(() => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory(), params.id)))",
    "  const resolveSession = () => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory(), params.id))\n  const sessionKey = createMemo(resolveSession, resolveSession())",
  ],
  [
    "  const { params, sessionKey, workspaceKey } = useSessionKey()\n  return {",
    "  const { params, sessionKey, workspaceKey } = useSessionKey()\n  const resolveTabs = () => layout.tabs(sessionKey)\n  const resolveView = () => layout.view(sessionKey)\n  return {",
  ],
  [
    "    tabs: createMemo(() => layout.tabs(sessionKey)),",
    "    tabs: createMemo(resolveTabs, resolveTabs()),",
  ],
  [
    "    view: createMemo(() => layout.view(sessionKey)),",
    "    view: createMemo(resolveView, resolveView()),",
  ],
]) {
  if (!sessionLayout.includes(before))
    throw new Error("Upstream session layout initialization changed.");
  sessionLayout = sessionLayout.replace(before, after);
}
writeFileSync(sessionLayoutPath, sessionLayout);
const serverPath = join(app, "src/utils/server.ts");
const server = readFileSync(serverPath, "utf8");
if (!server.includes("    fetch: input.fetch,"))
  throw new Error("Upstream V2 client transport changed.");
writeFileSync(
  serverPath,
  'import { createPrefixedFetch } from "../naru-gateway-transport"\n' +
    server.replace(
      "    fetch: input.fetch,",
      "    fetch: input.fetch ? createPrefixedFetch(input.server.url, input.fetch) : undefined,",
    ),
);
copyFileSync(
  resolve(import.meta.dirname, "../../../apps/opencode-gateway/src/browser-transport.ts"),
  join(app, "src/naru-gateway-transport.ts"),
);
const vitePath = join(app, "vite.config.ts");
let vite = readFileSync(vitePath, "utf8");
const config = "export default defineConfig({";
if (!vite.includes(config)) throw new Error("Upstream Vite integration point changed.");
vite = vite.replace(config, config + '\n  base: "/omo/",');
writeFileSync(vitePath, vite);
const htmlPath = join(app, "index.html");
let html = readFileSync(htmlPath, "utf8");
// Public metadata uses the same prefix as the official Vite-built assets.
html = html.replace(/(href|content)="\/(?!\/)([^"]+)"/g, '$1="/omo/$2"');
writeFileSync(htmlPath, html);
const manifestPath = join(app, "public/site.webmanifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.id = "/omo/";
manifest.start_url = "/omo/";
manifest.scope = "/omo/";
for (const icon of manifest.icons ?? [])
  if (typeof icon.src === "string" && icon.src.startsWith("/") && !icon.src.startsWith("/omo/"))
    icon.src = "/omo" + icon.src;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("Prepared pinned OpenCode UI for the /omo Gateway route.");
