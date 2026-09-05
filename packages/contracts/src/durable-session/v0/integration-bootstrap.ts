import { z } from "zod";
import {
  AppIdSchema,
  IntegrationDescriptorSchema,
  ProfileIdSchema,
  RootedWorkingDirectorySchema,
  RuntimeIdSchema,
  SessionIdSchema,
  SubjectIdSchema,
  UnixTimeMillisecondsSchema,
} from "./common.js";

/**
 * Signed by the Host for one concrete runtime and consumed by an app-owned
 * integration launcher/producer. The descriptor is redacted configuration,
 * never an inline secret channel.
 */
export const IntegrationBootstrapClaimsV0Schema = z.strictObject({
  version: z.literal(0),
  appId: AppIdSchema,
  subject: SubjectIdSchema,
  sessionId: SessionIdSchema,
  runtimeId: RuntimeIdSchema,
  profileId: ProfileIdSchema,
  cwd: RootedWorkingDirectorySchema,
  integration: IntegrationDescriptorSchema,
  issuedAtMs: UnixTimeMillisecondsSchema,
});

export type IntegrationBootstrapClaimsV0 = z.infer<typeof IntegrationBootstrapClaimsV0Schema>;
