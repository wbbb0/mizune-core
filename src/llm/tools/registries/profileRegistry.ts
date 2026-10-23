import { characterToolDescriptors, characterToolHandlers } from "../../../character/tools.ts";
import { profileToolDescriptors, profileToolHandlers } from "../profile/profileTools.ts";
import { requestToolDescriptors, requestToolHandlers } from "../profile/requestTools.ts";
import { whitelistToolDescriptors, whitelistToolHandlers } from "../profile/whitelistTools.ts";

export const profileToolDescriptorsRegistry = [
  ...profileToolDescriptors,
  ...characterToolDescriptors,
  ...requestToolDescriptors,
  ...whitelistToolDescriptors
];

export const profileToolHandlersRegistry = {
  ...profileToolHandlers,
  ...characterToolHandlers,
  ...requestToolHandlers,
  ...whitelistToolHandlers
};
