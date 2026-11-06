import { z } from "zod";

/** Provenance captured by authenticated ingress; restored bindings are revalidated before execution. */
export const toolActorAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external"), channelId: z.string().min(1), externalId: z.string().min(1), scope: z.enum(["private_user", "group_member"]), internalUserId: z.string().min(1) }),
  z.object({ kind: z.literal("web"), internalUserId: z.string().min(1) })
]);
export type ToolActorAuthorization = z.infer<typeof toolActorAuthorizationSchema>;
