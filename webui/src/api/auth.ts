import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { api } from "./client";

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

export interface AuthSettings {
  enabled: boolean;
  username: string;
  passwordUpdatedAt: number;
  passkey: null | {
    label: string;
    createdAt: number;
    lastUsedAt: number | null;
  };
}

export const authApi = {
  me(): Promise<AuthStatus> { return api.get("/api/auth/me"); },
  login(password: string): Promise<{ ok: boolean }> {
    return api.post("/api/auth/login", { password });
  },
  logout(): Promise<{ ok: boolean }> { return api.post("/api/auth/logout"); },
  configSummary(): Promise<{ access: { ownerId: string | null } }> { return api.get("/api/config-summary"); },
  settings(): Promise<AuthSettings> { return api.get("/api/auth/settings"); },
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return api.post("/api/auth/password", { currentPassword, newPassword });
  },
  beginPasskeyRegistration(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return api.post("/api/auth/passkey/register/options");
  },
  finishPasskeyRegistration(response: RegistrationResponseJSON, label: string): Promise<{ ok: boolean }> {
    return api.post("/api/auth/passkey/register/verify", { response, label });
  },
  beginPasskeyLogin(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return api.post("/api/auth/passkey/login/options");
  },
  finishPasskeyLogin(response: AuthenticationResponseJSON): Promise<{ ok: boolean }> {
    return api.post("/api/auth/passkey/login/verify", { response });
  },
  deletePasskey(): Promise<{ ok: boolean }> {
    return api.delete("/api/auth/passkey");
  }
};
