import type { BrowserService } from "#services/web/browser/browserService.ts";

export interface BrowserAdminService {
  listProfiles(): ReturnType<BrowserService["listProfiles"]>;
  inspectProfile(profileId: string): ReturnType<BrowserService["inspectProfile"]>;
  saveProfile(profileId: string): ReturnType<BrowserService["saveProfile"]>;
  clearProfile(profileId: string): ReturnType<BrowserService["clearProfile"]>;
}

export function createBrowserAdminService(input: {
  browserService: Pick<BrowserService, "listProfiles" | "inspectProfile" | "saveProfile" | "clearProfile">;
}): BrowserAdminService {
  return {
    listProfiles() {
      return input.browserService.listProfiles();
    },
    inspectProfile(profileId: string) {
      return input.browserService.inspectProfile(profileId);
    },
    saveProfile(profileId: string) {
      return input.browserService.saveProfile(profileId);
    },
    clearProfile(profileId: string) {
      return input.browserService.clearProfile(profileId);
    }
  };
}
