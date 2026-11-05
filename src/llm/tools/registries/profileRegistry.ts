import type { AppConfig } from "#config/config.ts";
import { characterToolDescriptors, characterToolHandlers } from "../../../character/tools.ts";
import { profileToolDescriptors, profileToolHandlers } from "../profile/profileTools.ts";
import { requestToolDescriptors, requestToolHandlers } from "../profile/requestTools.ts";
import { whitelistToolDescriptors, whitelistToolHandlers } from "../profile/whitelistTools.ts";

export function profileToolDescriptorsRegistry(config?: AppConfig) {
  return [
    ...profileToolDescriptors,
    ...characterToolDescriptors(config),
    ...requestToolDescriptors,
    ...whitelistToolDescriptors
  ];
}

export const profileToolHandlersRegistry = {
  ...profileToolHandlers,
  ...characterToolHandlers,
  ...requestToolHandlers,
  ...whitelistToolHandlers
};
