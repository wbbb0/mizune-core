import { crossChatToolDescriptors, crossChatToolHandlers } from "../conversation/crossChatTools.ts";
import { forwardToolDescriptors, forwardToolHandlers } from "../conversation/forwardTools.ts";
import { imageToolDescriptors, imageToolHandlers } from "../conversation/imageTools.ts";
import { messageToolDescriptors, messageToolHandlers } from "../conversation/messageTools.ts";
import { sessionToolDescriptors, sessionToolHandlers } from "../conversation/sessionTools.ts";

export const conversationToolDescriptors = [
  ...crossChatToolDescriptors,
  ...forwardToolDescriptors,
  ...imageToolDescriptors,
  ...messageToolDescriptors,
  ...sessionToolDescriptors
];

export const conversationToolHandlers = {
  ...crossChatToolHandlers,
  ...forwardToolHandlers,
  ...imageToolHandlers,
  ...messageToolHandlers,
  ...sessionToolHandlers
};
