import { profileToolDescriptors, profileToolHandlers } from "../profile/profileTools.ts";
import { requestToolDescriptors, requestToolHandlers } from "../profile/requestTools.ts";
import { whitelistToolDescriptors, whitelistToolHandlers } from "../profile/whitelistTools.ts";

export const profileToolDescriptorsRegistry = [
  ...profileToolDescriptors,
  ...requestToolDescriptors,
  ...whitelistToolDescriptors
];

export const profileToolHandlersRegistry = {
  ...profileToolHandlers,
  ...requestToolHandlers,
  ...whitelistToolHandlers
};
