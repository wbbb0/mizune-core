# Session Identity And Browser Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining refactor work for session identity display/helpers and BrowserService decomposition, leaving only the toolset regex supplement follow-up in the refactor doc.

**Architecture:** Extend the session identity domain with centralized display/predicate helpers, then split browser orchestration into page/profile/janitor services behind the existing `BrowserService` facade so public callers keep the same entrypoint while internal ownership becomes explicit.

**Tech Stack:** Node.js, TypeScript, tsx tests

---

### Task 1: Session Identity Helper Coverage

**Files:**
- Modify: `src/conversation/session/sessionIdentity.ts`
- Modify: `src/conversation/session/sessionStateFactory.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `src/modes/scenarioHost/stateStore.ts`
- Modify: `src/app/messaging/directCommands.ts`
- Test: `test/session/session-identity.test.tsx`

- [ ] Add failing tests for session identity display/helper behavior.
- [ ] Run `npx tsx test/session/session-identity.test.tsx` and confirm the new assertions fail for missing helpers.
- [ ] Implement centralized display/predicate helpers and migrate the obvious fallback call sites to them.
- [ ] Re-run `npx tsx test/session/session-identity.test.tsx` and confirm it passes.

### Task 2: Browser Service Split

**Files:**
- Create: `src/services/web/browser/browserPageService.ts`
- Create: `src/services/web/browser/browserProfileService.ts`
- Create: `src/services/web/browser/browserSessionJanitor.ts`
- Modify: `src/services/web/browser/browserService.ts`
- Test: `test/browser/profile-service.test.tsx`
- Test: `test/browser/session-janitor.test.tsx`
- Test: `test/browser/service-runtime.test.tsx`

- [ ] Add failing tests for the new browser profile/janitor ownership boundaries.
- [ ] Run the focused browser tests and confirm they fail before implementation.
- [ ] Extract the new browser services and turn `BrowserService` into a thin facade that delegates to them.
- [ ] Re-run the focused browser tests and confirm they pass.

### Task 3: Refactor Doc Update

**Files:**
- Modify: `project-structure-refactor.md`

- [ ] Update the checklist and success criteria so session identity/browser items reflect the completed state.
- [ ] Leave only the toolset regex supplement follow-up marked as remaining.

### Task 4: Verification

**Files:**
- Test: `test/session/session-identity.test.tsx`
- Test: `test/browser/profile-service.test.tsx`
- Test: `test/browser/session-janitor.test.tsx`
- Test: `test/browser/service-runtime.test.tsx`
- Test: `test/internalApi/messaging-admin-service.test.tsx`

- [ ] Run the focused verification commands and confirm all pass.
- [ ] If types are touched broadly, run `npm run typecheck`.
