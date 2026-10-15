import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arr, logs, obj, str } from "./harness.js";
import { reads, writes } from "./proxy.js";

const schema = JSON.parse(readFileSync(join(logs, "schema/ClientRequest.json"), "utf8")) as unknown;
const schemaMethods = arr(obj(schema).oneOf)
  .flatMap((variant) => arr(obj(obj(obj(variant).properties).method).enum).map(str))
  .sort();
const typeMethods = [
  ...readFileSync(join(logs, "types/ClientRequest.ts"), "utf8").matchAll(/"method": "([^"]+)"/g),
]
  .map((match) => match[1]!)
  .sort();
const methods = [...new Set([...schemaMethods, ...typeMethods])].sort();
const typeOnly = typeMethods.filter((method) => !schemaMethods.includes(method));
const readMethods = new Set([
  ...reads,
  "server/diagnostics",
  "thread/attachment/list",
  "thread/attachmentOwner/list",
  "thread/search",
  "thread/searchOccurrences",
  "thread/timeline/list",
  "project/list",
  "project/read",
  "threadSection/list",
  "plugin/list",
  "plugin/search",
  "plugin/installed",
  "plugin/read",
  "plugin/skill/read",
  "plugin/share/list",
  "app/read",
  "app/list",
  "app/installed",
  "fs/readFile",
  "fs/getMetadata",
  "fs/readDirectory",
  "thread/realtime/listVoices",
  "modelProvider/capabilities/read",
  "environment/info",
  "environment/status",
  "memory/status",
  "account/usage/read",
  "getConversationSummary",
  "gitDiffToRemote",
  "fuzzyFileSearch",
]);
const subscriptions = new Set([
  "thread/resume",
  "thread/unsubscribe",
  "fs/watch",
  "fs/unwatch",
  "mcpServer/event/stream/start",
  "mcpServer/event/stream/stop",
  "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop",
]);
const execution = new Set([
  "thread/shellCommand",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/terminate",
  "mcpServer/tool/call",
  "mcpServer/resource/read",
  "fs/writeFile",
  "fs/createDirectory",
  "fs/remove",
  "fs/copy",
]);
const groups = new Map<string, string[]>();
for (const method of methods) {
  const category =
    method === "initialize"
      ? "handshake"
      : subscriptions.has(method)
        ? "subscription (params-sensitive)"
        : readMethods.has(method)
          ? "read"
          : execution.has(method) || /^(command|process)\//.test(method)
            ? "execution / external-effect"
            : /^thread\/(settings|memoryMode)/.test(method) ||
                /^(config|skills\/.*(set|write)|experimentalFeature\/enablement|environment\/add)/.test(
                  method,
                )
              ? "settings"
              : /^(thread\/|turn\/|review\/)/.test(method)
                ? "conversation-write"
                : "privileged / settings / unverified";
  groups.set(category, [...(groups.get(category) ?? []), method]);
}
const table = [
  "| 분류 | 설치 스키마 method (전체) |",
  "| --- | --- |",
  ...[...groups].map(
    ([category, values]) =>
      `| ${category} | ${values.map((method) => `\`${method}\``).join(", ")} |`,
  ),
];
writeFileSync(join(logs, "method-classification.md"), `${table.join("\n")}\n`, { mode: 0o600 });
writeFileSync(
  join(logs, "method-classification.json"),
  JSON.stringify(
    {
      methods: methods.length,
      typeOnly,
      groups: Object.fromEntries(groups),
      proxyReadAllowlist: [...reads],
      proxyWriterAllowlist: [...writes],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    schemaMethods: schemaMethods.length,
    classifiedMethods: methods.length,
    schemaAndTypesAgree: typeOnly.length === 0,
    typeOnly,
  }),
);
