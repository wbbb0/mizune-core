import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import type { UserStore } from "#identity/userStore.ts";

export interface OwnerBootstrapRequest {
  channelId: string;
  requesterUserId: string;
  targetUserId: string;
  chatType: "private" | "group";
}

/** Platform proof and delivery only; ownership and setup state belong to the shared service. */
export interface OwnerBootstrapTransport {
  validateTarget(request: OwnerBootstrapRequest): Promise<string | null>;
  notifyTarget(targetUserId: string, text: string): Promise<void>;
}

export function createOwnerBootstrap(deps: {
  setupStore: SetupStateStore;
  userIdentityStore: UserIdentityStore;
  userStore: UserStore;
  buildSetupInstructionText: () => Promise<string>;
}) {
  const isAvailable = async () => (await deps.setupStore.get()).state !== "ready" && !await deps.userIdentityStore.hasOwnerIdentity();
  return {
    isAvailable,
    async assignOwner(request: OwnerBootstrapRequest, transport: OwnerBootstrapTransport): Promise<string> {
      if (request.chatType !== "private") return "`.own` 只能在机器人私聊里使用。";
      if (!await isAvailable()) return "当前实例已完成管理者绑定，`.own` 不再可用。";
      const targetUserId = request.targetUserId.trim();
      if (!targetUserId) return "请提供有效的用户 ID，或直接使用 `.own` 绑定自己。";
      const reason = await transport.validateTarget({ ...request, targetUserId });
      if (reason) return reason;
      // Validation may require remote I/O. Recheck setup and claim at the repository boundary.
      if (!await isAvailable()) return "当前实例已完成管理者绑定，`.own` 不再可用。";
      await deps.userStore.ensureInternalUser("owner");
      if (!await deps.userIdentityStore.claimInitialOwnerIdentity({ channelId: request.channelId, externalId: targetUserId })) {
        return "当前实例已完成管理者绑定，`.own` 不再可用。";
      }
      const state = await deps.setupStore.advanceAfterOwnerBound();
      await transport.notifyTarget(targetUserId, await deps.buildSetupInstructionText());
      await deps.setupStore.markOwnerPromptSent();
      if (targetUserId !== request.requesterUserId) return `已将 ${targetUserId} 设为管理者，并通知对方${state.state === "ready" ? "可以开始对话" : "继续确认角色设定"}。`;
      return state.state === "ready" ? "已将你设为管理者。基础人格已确认，可以开始对话。" : "已将你设为管理者。接下来请配置并确认基础人格，允许留空。";
    }
  };
}
