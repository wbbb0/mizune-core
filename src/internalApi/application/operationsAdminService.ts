import type { InternalApiDeps } from "../types.ts";

export async function listRequests(deps: Pick<InternalApiDeps, "requestStore">) {
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

export async function listScheduledJobs(deps: Pick<InternalApiDeps, "scheduledJobStore">) {
  return {
    jobs: await deps.scheduledJobStore.list()
  };
}
