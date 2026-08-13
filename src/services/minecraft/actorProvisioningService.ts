import type { RuntimeResourceRecord } from "#runtime/resources/resourceTypes.ts";
import type { ConfiguredMinecraftActorClientFactory } from "./actorClientFactory.ts";
import type { MinecraftActorResourceManager } from "./actorResourceManager.ts";

export class MinecraftActorProvisioningService {
  constructor(
    private readonly endpoints: ConfiguredMinecraftActorClientFactory,
    private readonly manager: MinecraftActorResourceManager
  ) {}

  listEndpointIds(): string[] {
    return this.endpoints.listEndpointIds();
  }

  async ensure(input: {
    endpointId: string;
    ownerSessionId: string;
    title?: string | null;
    description?: string | null;
    persistentState?: string;
    currentGoal?: string | null;
  }): Promise<RuntimeResourceRecord> {
    const endpoint = this.endpoints.resolveEndpoint(input.endpointId);
    return this.manager.ensure({
      ownerSessionId: input.ownerSessionId,
      title: input.title ?? endpoint.endpointId,
      ...(input.description === undefined ? {} : { description: input.description }),
      actor: {
        ...endpoint.actor,
        ...(input.persistentState === undefined ? {} : { persistentState: input.persistentState }),
        ...(input.currentGoal === undefined ? {} : { currentGoal: input.currentGoal })
      }
    });
  }
}
