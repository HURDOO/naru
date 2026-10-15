import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The slice of the Claude Agent SDK that Naru uses (AP-D012). The SDK is proprietary and installed
 * by the user like the Claude CLI; Naru never bundles it and talks to it only through this port.
 * Types are structural so the repository has no dependency on the SDK package.
 */
export interface ClaudeSdkUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
  readonly session_id: string;
}

export type ClaudeSdkMessage = { readonly type: string; readonly subtype?: string } & Record<
  string,
  unknown
>;

export interface ClaudeSdkQuery extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<unknown>;
  close?(): void;
}

export type ClaudePermissionResult =
  | { readonly behavior: "allow"; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string };

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { readonly signal: AbortSignal },
) => Promise<ClaudePermissionResult>;

export interface ClaudeSdkPort {
  query(params: {
    readonly prompt: AsyncIterable<ClaudeSdkUserMessage>;
    readonly options: Record<string, unknown>;
  }): ClaudeSdkQuery;
  getSessionMessages(
    sessionId: string,
    options: { readonly dir?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<unknown[]>;
}

/**
 * Loads the user-installed SDK entry (`…/@anthropic-ai/claude-agent-sdk/sdk.mjs`). The path must be
 * an absolute, regular, owner-controlled file, the same trust rule Naru applies to agent CLIs.
 */
export async function loadClaudeSdk(entryPath: string): Promise<ClaudeSdkPort> {
  if (!isAbsolute(entryPath)) throw new Error("The Claude Agent SDK path must be absolute.");
  const canonical = realpathSync(entryPath);
  const metadata = lstatSync(canonical);
  if (!metadata.isFile()) throw new Error("The Claude Agent SDK entry must be a regular file.");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("The Claude Agent SDK must be owned by the service user.");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("The Claude Agent SDK must not be group- or world-writable.");
  }
  const loaded = (await import(pathToFileURL(canonical).href)) as Record<string, unknown>;
  if (typeof loaded.query !== "function" || typeof loaded.getSessionMessages !== "function") {
    throw new Error("The configured file is not the Claude Agent SDK.");
  }
  return loaded as unknown as ClaudeSdkPort;
}
