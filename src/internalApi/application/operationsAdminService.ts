import type { InternalApiOperationsDeps } from "../types.ts";

export async function listRequests(deps: Pick<InternalApiOperationsDeps, "requestStore">) {
  const [friends, groups] = await Promise.all([
    deps.requestStore.listFriendRequests(),
    deps.requestStore.listGroupRequests()
  ]);
  return {
    requests: {
      friends,
      groups
    }
  };
}

export async function listScheduledJobs(deps: Pick<InternalApiOperationsDeps, "scheduledJobStore">) {
  return {
    jobs: await deps.scheduledJobStore.list()
  };
}
