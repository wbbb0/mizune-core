import { webToolDescriptors, webToolHandlers } from "../web/webTools.ts";

export const webToolDescriptorsRegistry = [...webToolDescriptors];

export const webToolHandlersRegistry = {
  ...webToolHandlers
};
