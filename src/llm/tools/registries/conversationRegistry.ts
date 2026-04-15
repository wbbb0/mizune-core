import { crossChatToolDescriptors, crossChatToolHandlers } from "../conversation/crossChatTools.ts";
import { forwardToolDescriptors, forwardToolHandlers } from "../conversation/forwardTools.ts";
import { imageToolDescriptors, imageToolHandlers } from "../conversation/imageTools.ts";
import { messageToolDescriptors, messageToolHandlers } from "../conversation/messageTools.ts";
import { scenarioHostToolDescriptors, scenarioHostToolHandlers } from "../conversation/scenarioHostTools.ts";
import { sessionToolDescriptors, sessionToolHandlers } from "../conversation/sessionTools.ts";

export const conversationToolDescriptors = [
  ...crossChatToolDescriptors,
  ...forwardToolDescriptors,
  ...imageToolDescriptors,
  ...messageToolDescriptors,
  ...scenarioHostToolDescriptors,
  ...sessionToolDescriptors
];

export const conversationToolHandlers = {
  ...crossChatToolHandlers,
  ...forwardToolHandlers,
  ...imageToolHandlers,
  ...messageToolHandlers,
  ...scenarioHostToolHandlers,
  ...sessionToolHandlers
};
