export interface CreateSessionPayload {
  title?: string;
  modeId?: string;
}

export function buildCreateSessionPayload(input: {
  title: string;
  modeId: string;
}): CreateSessionPayload {
  const payload: CreateSessionPayload = {};

  const title = input.title.trim();
  if (title) {
    payload.title = title;
  }

  const modeId = input.modeId.trim();
  if (modeId) {
    payload.modeId = modeId;
  }

  return payload;
}
