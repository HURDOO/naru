import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture } from "../../durable-session-host/test/support.js";
import { buildApp } from "../src/app.js";
import { NaruRepository } from "../src/database.js";
import { DurableHostSessionFacade } from "../src/durable-session-facade.js";
import {
  UdsDurableSessionLifecycleClient,
  type DurableHostConfig,
} from "../src/durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "../src/durable-session-stream-port.js";
import { NaruCodexIntegration } from "../src/integrations/codex/port.js";
import { CodexIntegrationServer } from "../src/integrations/codex/server.js";
import { LaunchProfileRegistry } from "../src/launch-profiles.js";
import { hashPassword } from "../src/password.js";
import { ProjectPathPolicy } from "../src/path-policy.js";

/** Isolated Host + Naru + real Codex, with a loopback synthetic model and no account credentials. */
export async function startCodexAcceptanceFixture(
  codexExecutable: string,
  testPassword: string = randomUUID(),
  responseText = "NARU_T59_READY",
) {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 required");
  const fixture = createHostFixture();
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const home = join(fixture.root, "codex-home");
  mkdirSync(home, { mode: 0o700 });
  const fixtureCredential = randomUUID();
  const mcpEntry = join(home, "fixture-mcp.cjs");
  writeFileSync(
    mcpEntry,
    `const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\\n");
let pending;
readline.createInterface({input:process.stdin}).on("line", line => {
  const message=JSON.parse(line);
  if(message.method==="initialize") send({id:message.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}});
  else if(message.method==="tools/list") send({id:message.id,result:{tools:[{name:"confirm",description:"Request a fixture confirmation",inputSchema:{type:"object",properties:{}}}]}});
  else if(message.method==="tools/call") {pending=message.id;send({id:"fixture-elicitation",method:"elicitation/create",params:{_meta:{codex_requires_user_input:true},message:"Fixture confirmation",requestedSchema:{type:"object",properties:{choice:{type:"string",title:"Fixture choice",enum:["Proceed","Cancel"],default:"Proceed"}},required:["choice"]}}});}
  else if(message.id==="fixture-elicitation") send({id:pending,result:{content:[{type:"text",text:"Fixture confirmation handled"}]}});
});`,
    { mode: 0o600 },
  );
  let modelRequests = 0;
  let greetingRequests = 0;
  let mcpRequests = 0;
  let mcpAdvertised = false;
  const toolOutputFlags = new Set<string>();
  const model = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (body.includes("Reply with a short greeting.")) greetingRequests += 1;
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      if (request.method !== "POST" || body.length === 0) {
        response.writeHead(405);
        response.end();
        return;
      }
      modelRequests += 1;
      const input = (JSON.parse(body) as { input?: { type?: string }[] }).input ?? [];
      for (const item of input.filter((entry) => entry.type === "function_call_output")) {
        const output = JSON.stringify(item);
        for (const label of [
          "not found",
          "unknown",
          "Unknown",
          "invalid",
          "Invalid",
          "error",
          "Error",
          "unsupported",
          "denied",
          "Fixture confirmation handled",
          "elicitation",
          "not available",
        ])
          if (output.includes(label)) toolOutputFlags.add(label);
      }
      const useMcp =
        body.includes("Request fixture confirmation.") &&
        !input.some((item) => item.type === "function_call_output");
      if (useMcp) mcpRequests += 1;
      mcpAdvertised ||= body.includes('"name":"mcp__fixture__confirm"');
      const message = useMcp
        ? {
            type: "function_call",
            id: `fc_${modelRequests}`,
            call_id: `call_${modelRequests}`,
            namespace: "mcp__fixture",
            name: "confirm",
            arguments: "{}",
            status: "completed",
          }
        : {
            id: `msg_${modelRequests}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: responseText, annotations: [] }],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: `resp_${modelRequests}`, status: "in_progress", output: [] },
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            id: `resp_${modelRequests}`,
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelAddress = model.address();
  if (modelAddress === null || typeof modelAddress === "string")
    throw new Error("Model bind failed");
  const projectRoot = fixture.config.roots[0]!;
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "gpt-6-sol"',
      'model_provider = "fixture"',
      'cli_auth_credentials_store = "file"',
      "[model_providers.fixture]",
      'name = "Local acceptance fixture"',
      `base_url = "http://127.0.0.1:${modelAddress.port}/v1"`,
      'wire_api = "responses"',
      'env_key = "CODEX_FIXTURE_API_KEY"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "[features]",
      "shell_snapshot = false",
      "enable_request_compression = false",
      "[notice.model_migrations]",
      '"gpt-5.6-sol" = "gpt-6-sol"',
      '"gpt-5.6-luna" = "gpt-6-luna"',
      "[mcp_servers.fixture]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(mcpEntry)}]`,
      `[projects.${JSON.stringify(join(projectRoot.path, "sample"))}]`,
      'trust_level = "trusted"',
    ].join("\n"),
    { mode: 0o600 },
  );
  const environment: Record<string, string> = {
    HOME: home,
    CODEX_HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SHELL: "/bin/zsh",
    CODEX_FIXTURE_API_KEY: fixtureCredential,
    OPENAI_API_KEY: fixtureCredential,
  };
  const config: DurableHostConfig = {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds: ["shell", "codex-main", "codex-quick"],
    roots: fixture.config.roots,
  };
  const repository = new NaruRepository(join(fixture.root, "naru.sqlite"), {
    sessionOwner: "durable-host",
  });
  const integration = new NaruCodexIntegration(
    repository,
    config,
    new LaunchProfileRegistry({ codexExecutable, environment }),
  );
  const integrationServer = new CodexIntegrationServer(fixture.root, integration);
  await integrationServer.start();
  const node = realpathSync(process.execPath);
  const host = await startDurableSessionHost(
    DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      profiles: config.profileIds.map((profileId) => ({
        profileId,
        executable: profileId === "shell" ? "/bin/zsh" : node,
        args:
          profileId === "shell"
            ? ["-l"]
            : [
                process.env.NARU_ACTUAL_LAUNCHER ??
                  join(repositoryRoot, "apps/server/dist/codex-integration-launcher.js"),
              ],
        envPolicyId: "safe-env",
        resourcePolicyId: "fixture-resource",
      })),
      environmentPolicies: [
        {
          envPolicyId: "safe-env",
          inherit: [],
          values: { ...environment, NARU_CODEX_INTEGRATION_SOCKET: integrationServer.socketPath },
        },
      ],
      resourcePolicies: [
        {
          ...fixture.config.resourcePolicies[0],
          allowedExecutables: [node, "/bin/zsh"],
          stopTimeoutMs: 5_000,
        },
      ],
      integrationPolicies: [
        {
          policyRef: "naru-codex-v0",
          appId: config.appId,
          integrationKind: "codex",
          profileIds: ["codex-main", "codex-quick"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    }),
    { logger: silentHostLogger, hostEnvironment: {} },
  );
  const lifecycle = new UdsDurableSessionLifecycleClient(config);
  const supervisor = new DurableHostSessionFacade(
    repository,
    config,
    lifecycle,
    new UdsDurableSessionStreamPort(config),
    Date.now,
    integration,
    integrationServer,
  );
  await supervisor.reconcile();
  const allowedOrigins = new Set<string>();
  const app = await buildApp(
    {
      environment: "test",
      authMode: "app-managed",
      host: "127.0.0.1",
      port: 0,
      allowedOrigins,
      projectRoots: [projectRoot.path],
      appBasePath: "/",
      dataDir: fixture.root,
      passwordHash: await hashPassword(testPassword),
      sessionSecret: randomUUID(),
      sessionCookieName: "naru_t59_test",
      secureCookie: false,
      sessionRuntime: config,
      webDist: join(repositoryRoot, "apps/web/dist"),
    },
    { repository, supervisor, pathPolicy: await ProjectPathPolicy.create([projectRoot.path]) },
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  allowedOrigins.add(origin);
  const project = repository.createProject(
    join(projectRoot.path, "sample"),
    "Codex socket acceptance",
  );
  return {
    origin,
    fixture,
    project,
    repository,
    supervisor,
    lifecycle,
    config,
    get modelRequests() {
      return modelRequests;
    },
    get greetingRequests() {
      return greetingRequests;
    },
    get mcpRequests() {
      return mcpRequests;
    },
    get mcpAdvertised() {
      return mcpAdvertised;
    },
    get toolOutputFlags() {
      return [...toolOutputFlags];
    },
    async close() {
      await host.close();
      await app.close();
      await new Promise<void>((resolve) => model.close(() => resolve()));
    },
  };
}
