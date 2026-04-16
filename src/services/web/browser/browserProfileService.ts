import type { AppConfig } from "#config/config.ts";
import { BrowserSessionRuntime, type BrowserSessionRecord } from "./browserSessionRuntime.ts";
import { BrowserProfileStore } from "./browserProfileStore.ts";
import type {
  BrowserProfileInspectResult,
  BrowserProfileListResult,
  BrowserProfileMutationResult
} from "./types.ts";

type BrowserProfileResolution = {
  profileId: string | null;
  storageState: unknown | null;
  sessionStorageByOrigin: Record<string, Record<string, string>>;
  persistState: boolean;
};

export class BrowserProfileService {
  constructor(
    private readonly deps: {
      config: AppConfig;
      sessions: BrowserSessionRuntime;
      profileStore: BrowserProfileStore;
    }
  ) {}

  async resolveProfileForOpen(ownerSessionId: string | null): Promise<BrowserProfileResolution> {
    if (!ownerSessionId || !this.deps.config.browser.playwright.persistSessionState) {
      return {
        profileId: null,
        storageState: null,
        sessionStorageByOrigin: {},
        persistState: false
      };
    }

    const profile = await this.deps.profileStore.ensureProfile(ownerSessionId);
    const loadedProfile = await this.deps.profileStore.loadProfile(profile.profileId);
    return {
      profileId: loadedProfile?.profileId ?? profile.profileId,
      storageState: loadedProfile?.storageState ?? null,
      sessionStorageByOrigin: loadedProfile?.sessionStorageByOrigin ?? {},
      persistState: true
    };
  }

  async listProfiles(): Promise<BrowserProfileListResult> {
    return {
      ok: true,
      profiles: await this.deps.profileStore.listProfiles()
    };
  }

  async inspectProfile(profileId: string): Promise<BrowserProfileInspectResult> {
    const profile = await this.deps.profileStore.inspectProfile(profileId);
    if (!profile) {
      throw new Error(`Unknown profile_id: ${profileId}`);
    }
    return {
      ok: true,
      profile
    };
  }

  async saveProfile(profileId: string): Promise<BrowserProfileMutationResult> {
    const normalizedProfileId = String(profileId ?? "").trim();
    if (!normalizedProfileId) {
      throw new Error("profile_id is required");
    }

    const liveSession = this.deps.sessions.findByProfileId(normalizedProfileId);
    if (liveSession) {
      await this.persistSessionProfile(liveSession);
    } else {
      const existing = await this.deps.profileStore.inspectProfile(normalizedProfileId);
      if (!existing) {
        throw new Error(`Unknown profile_id: ${profileId}`);
      }
      await this.deps.profileStore.markUsed(normalizedProfileId);
    }

    return {
      ok: true,
      profile_id: normalizedProfileId,
      saved: true
    };
  }

  async clearProfile(profileId: string): Promise<BrowserProfileMutationResult> {
    const normalizedProfileId = String(profileId ?? "").trim();
    if (!normalizedProfileId) {
      throw new Error("profile_id is required");
    }
    const cleared = await this.deps.profileStore.clearProfile(normalizedProfileId);
    if (!cleared) {
      throw new Error(`Unknown profile_id: ${profileId}`);
    }
    for (const session of this.deps.sessions.values()) {
      if (session.profileId === normalizedProfileId) {
        session.profileId = null;
      }
    }
    return {
      ok: true,
      profile_id: normalizedProfileId,
      cleared: true
    };
  }

  async persistSessionProfile(session: BrowserSessionRecord): Promise<void> {
    if (!session.profileId || !session.ownerSessionId || !this.deps.config.browser.playwright.persistSessionState) {
      return;
    }
    const persisted = await session.backend.persistState(session.state);
    await this.deps.profileStore.saveProfile({
      profileId: session.profileId,
      ownerSessionId: session.ownerSessionId,
      storageState: persisted.storageState,
      sessionStorageByOrigin: persisted.sessionStorageByOrigin
    });
  }
}
