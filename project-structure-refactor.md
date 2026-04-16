# Project Structure Optimization Plan

> Goal: systematically reduce cross-module coupling, duplicated domain rules, patch-style flow control, and oversized orchestrator objects in the runtime. Rebuild the project around clearer domain boundaries so future feature work lands in smaller, more predictable modules instead of further expanding central coordinator files.
>
> This refactor is allowed to be invasive. Prioritize boundary clarity, single-responsibility structure, and long-term maintainability over backward compatibility. If an existing abstraction only survives by accumulating exceptions, replace it instead of preserving it.

## Current Checkpoint (2026-04-15)

- [x] Session identity parsing/building has been centralized and covered by focused tests.
- [x] `SessionManager` internals have been split into dedicated helper modules such as store/lifecycle/history/debug/trigger-queue ownership.
- [x] Toolset metadata has been split from supplement heuristics, and supplement signal extraction now lives in its own module.
- [x] Some downstream callers now depend on narrower session capability interfaces instead of the full `SessionManager`, including debounce/compression, conversation access, setup context, direct commands, the messaging ingress flow, part of the internal API surface, several generation subflows, and tool runtime wiring.
- [x] A first batch of obsolete `SessionManager` façade passthroughs with no remaining external callers has been deleted, and affected tests were migrated to the clearer session/history APIs.
- [ ] `SessionManager` is still the main public facade for many callers; caller migration and passthrough deletion are not done yet.
- [ ] Generation and internal API code still depend on several broad dependency bags; dependency narrowing has started, and generation/tool/internal-API sub-deps now use more explicit session capability groups, but the main executor/runtime graph is still broad.
- [ ] Browser split, flow-control timing cleanup, and deeper bootstrap/internal-API cleanup have not started in earnest.
- [ ] The current priority is to finish the existing session/planner boundary cleanup slice before opening new refactor fronts.

---

## Success Criteria

- [ ] Session-related behavior is no longer concentrated in a single oversized manager class.
- [ ] The generation pipeline no longer receives a near-global service graph as a default dependency shape.
- [x] Session identity parsing/building rules are centralized in one domain module instead of repeated in multiple files.
- [ ] Toolset planning no longer depends primarily on a growing pile of regex-based supplementation rules.
- [ ] Browser runtime responsibilities are split into smaller services with explicit ownership boundaries.
- [ ] Polling sleeps and patch-style timing hacks are replaced by explicit state transitions, events, or shared policy helpers.
- [ ] Bootstrap, routing, generation, tool runtime, and internal API layers have narrower dependency contracts.
- [ ] Structural refactors include updated tests that lock in the new boundaries and current behavior.
- [ ] During optimization, touched code paths gain concise explanatory comments where the logic would otherwise be non-obvious.

---

## Design Principles

- [ ] Prefer explicit domain modules over “manager” or “service” classes that own unrelated responsibilities.
- [ ] Prefer narrow capability interfaces over passing the full runtime service graph into business logic.
- [ ] Prefer single-source domain rules over repeated string parsing, ad hoc conditionals, or copy-pasted helpers.
- [ ] Prefer structural fixes over adding one more branch for one more scenario.
- [ ] Prefer event/state-driven coordination over sleeps, polling loops, and timing constants.
- [ ] Prefer deleting obsolete paths over carrying compatibility scaffolding by default.
- [ ] Treat comments as part of maintainability, but keep them focused on intent, invariants, and tricky flows rather than narrating obvious code.

---

## Comment Policy For This Refactor

- [ ] Add comments when a function encodes an invariant, ordering requirement, concurrency guard, or non-obvious business rule.
- [ ] Add short module-level comments when a file defines a boundary or coordination role that is not obvious from the filename alone.
- [ ] Add comments before complex state transitions, queue behavior, epoch matching, and mode/setup lifecycle logic.
- [ ] Do not add comments that merely restate the code line-by-line.
- [ ] When splitting large modules, preserve or improve the readability of the moved logic with small targeted comments.
- [ ] If a patch removes historical workaround logic, add a brief comment only where the new invariant needs to be protected.

---

## Primary Optimization Targets

### 1. Session Domain Decomposition

- [ ] Split the current session domain into smaller responsibilities instead of continuing to expand `SessionManager`.
- [ ] Separate at least the following concerns:
  - session store / lookup
  - lifecycle and phase transitions
  - transcript and visible history projection
  - debug control and debug markers
  - outbound sent-message tracking / retract window
  - internal trigger queue
  - compression snapshot application
- [ ] Ensure callers depend on the narrowest session capability they need.
- [ ] Remove duplicated “epoch match then mutate” patterns where a smaller domain helper can own the invariant.

### 2. Runtime Dependency Narrowing

- [ ] Replace large dependency bags such as generation/runtime/internal API deps with smaller capability groups.
- [ ] Prevent generation code from freely depending on unrelated identity, browser, shell, scheduler, and storage services unless the path truly needs them.
- [ ] Keep composition-root assembly centralized, but stop leaking the full assembled graph into lower layers.
- [ ] Prefer dependency contracts shaped around use cases, for example:
  - prompt context access
  - session control
  - tool execution
  - persistence hooks
  - outbound delivery

### 3. Session Identity Unification

- [x] Introduce a single session identity module that owns:
  - build
  - parse
  - type guards
  - display helpers
  - participant derivation helpers
- [x] Replace ad hoc `startsWith("private:")` / `startsWith("group:")` logic throughout the production codebase.
- [x] Eliminate repeated local `parseSessionId()` implementations.
- [ ] Make it easy to extend the identity model later without global search-and-replace risk.

### 4. Toolset Planning Cleanup

- [ ] Stop growing the current toolset planner mainly through static tables plus increasingly broad regex supplements.
- [ ] Separate toolset declaration from heuristic selection policy.
- [ ] Move mode-specific toolset policy closer to the mode definition or a dedicated planning config layer.
- [ ] Replace fragile string-pattern supplementation with more structured signals where possible, such as:
  - message features
  - recent tool-domain activity
  - explicit referenced artifacts
  - mode/setup state
- [ ] Keep final toolset visibility rules auditable and easy to explain.

### 5. Browser Runtime Separation

- [ ] Split browser concerns into explicit modules instead of keeping session runtime, profile persistence, resource registry integration, and asset import in one service.
- [ ] Separate at least:
  - browser session orchestration
  - browser profile persistence
  - browser resource registry sync
  - screenshot / download asset import
  - backend-specific Playwright integration
- [ ] Make backend-independent orchestration easier to test without a browser process.

### 6. Flow-Control Patch Removal

- [ ] Audit sleeps, polling loops, retry timing, and hardcoded control windows in generation, admin messaging, and command flows.
- [ ] Replace fixed waits with explicit readiness checks or queue/event notifications.
- [ ] Centralize remaining timing policies in named constants or shared runtime policy modules.
- [ ] Remove business logic that depends on “wait a little and hope state settles.”

### 7. Bootstrap / Routing / Command Boundary Cleanup

- [ ] Remove cross-layer coupling where bootstrap or routing code depends directly on command parsing details.
- [ ] Ensure startup flow depends on a dedicated owner-bootstrap policy instead of reusing general chat command parsing as an implicit signal.
- [ ] Keep direct command routing scoped to messaging/application logic, not infrastructure bootstrap decisions.

### 8. Internal API Service Boundary Cleanup

- [ ] Reduce the breadth of `InternalApiDeps` and similar admin-facing service bundles.
- [ ] Split API-facing application services by domain rather than passing large mixed dependency objects through route registration.
- [ ] Ensure internal API modules do not become a second service locator.

---

## Workstream Plan

### Workstream A: Session Domain Refactor

- [x] Map all current `SessionManager` responsibilities and group them by domain.
- [x] Introduce a minimal `SessionStore` abstraction first, without changing behavior.
- [x] Extract lifecycle transition helpers into a dedicated session lifecycle service.
- [x] Extract transcript/history/query operations into a dedicated history service.
- [x] Extract debug state and sent-message tracking into dedicated modules.
- [x] Extract internal trigger queue ownership into a dedicated module.
- [ ] Update callers incrementally to use smaller interfaces.
- [ ] Delete dead passthrough methods from the old manager façade once migration is complete.

### Workstream B: Dependency Graph Refactor

- [ ] Inventory each field in generation/runtime/internal API dependency structs.
- [ ] Classify each dependency as:
  - truly required
  - incidental convenience
  - leaked cross-domain dependency
- [ ] Replace large dependency structs with smaller capability-oriented contracts.
- [x] Move feature-specific wiring closer to the composition root.
- [ ] Avoid adding any new large “Deps” type during the refactor.

### Workstream C: Session Identity Refactor

- [x] Add a canonical session identity module under the session/conversation domain.
- [x] Migrate the current production builders/parsers to the shared module.
- [x] Remove repeated local helpers and direct prefix slicing.
- [x] Add focused tests for parse/build/round-trip/display behavior.

### Workstream D: Planner And Toolset Refactor

- [x] Split toolset metadata declarations from planner heuristics.
- [ ] Audit current supplementation patterns and group them by actual business intent.
- [x] Replace the most brittle regex-only cases with structured message features first.
- [ ] Keep only heuristics that still have clear, defensible semantics after cleanup.
- [ ] Ensure setup and mode-specific toolset overrides remain explicit and local.

### Workstream E: Browser Module Refactor

- [ ] Extract registry/persistence/import concerns from `BrowserService`.
- [ ] Keep one orchestration entrypoint, but make internals domain-oriented and testable.
- [ ] Reduce constructor breadth by passing smaller collaborators.
- [ ] Add comments around page session expiry and profile persistence invariants.

### Workstream F: Coordination Timing Refactor

- [ ] Catalog current fixed sleeps, polling loops, and timing windows.
- [ ] Replace them one by one with explicit state/event-driven coordination.
- [ ] Keep temporary shared timing helpers only where true asynchronous backpressure still requires them.
- [ ] Document the remaining timing assumptions with comments and tests.

### Workstream G: Internal API And Bootstrap Cleanup

- [ ] Refactor bootstrap-time command coupling out of infrastructure wiring.
- [ ] Reduce internal API dependency breadth through domain service extraction.
- [ ] Keep route files thin and application services explicit.
- [ ] Add comments where auth, WebUI hosting, and API exposure rules rely on subtle invariants.

---

## Suggested Execution Order

### Phase 1: Foundational Boundary Work

- [x] Introduce unified session identity helpers.
- [x] Introduce narrower dependency interfaces without major behavioral changes.
- [ ] Add baseline tests around current session, trigger, generation, and toolset behavior before larger movement.

### Phase 2: Session-Centric Extraction

- [x] Split `SessionManager` into smaller domain services.
- [ ] Migrate generation, messaging, and admin code to the smaller session interfaces.
- [ ] Remove obsolete façade methods and duplicated helper logic.

### Phase 3: Planner And Browser Cleanup

- [ ] Refactor toolset planning and supplementation.
- [ ] Split browser runtime responsibilities.
- [ ] Update tests and documentation to match the new boundaries.

### Phase 4: Coordination And Bootstrap Cleanup

- [ ] Remove patch-style waits and polling loops.
- [ ] Decouple bootstrap and command parsing.
- [ ] Shrink internal API dependency surfaces.

### Phase 5: Final Simplification Pass

- [ ] Delete dead compatibility code and unused helper paths created during migration.
- [ ] Re-check module ownership and file placement after all moves.
- [ ] Add final high-signal comments to tricky coordination paths.

---

## Guardrails During Implementation

- [ ] Do not keep both old and new abstractions alive longer than needed.
- [ ] Do not move code into a new file without also clarifying ownership and naming.
- [ ] Do not replace one god object with several thin wrappers around the same hidden god object.
- [ ] Do not preserve scattered string-based domain rules once a canonical helper exists.
- [ ] Do not add new regex heuristics to the planner before the planning cleanup workstream is complete, unless needed for a blocking regression fix.
- [ ] Do not leave newly split coordination logic undocumented if it relies on ordering, epoch matching, or queue semantics.

---

## Testing Requirements

- [x] Add unit tests for the new session identity module.
- [ ] Add or update tests around session lifecycle transitions and epoch/response guards.
- [ ] Add focused tests for internal trigger queue behavior after extraction.
- [ ] Add tests for toolset planning inputs and outputs after heuristic cleanup.
- [ ] Add tests for browser service split boundaries where backend-free validation is possible.
- [ ] Update any affected admin/API tests after dependency narrowing.
- [ ] Before each milestone is considered complete, run:
  - `npm run typecheck:all`
  - `npm run test`

---

## Documentation Follow-Up

- [ ] Update `AGENTS.md` if the actual source layout or refactor strategy changes materially.
- [ ] Update `README.md` and relevant docs when module boundaries or runtime responsibilities are renamed.
- [ ] Keep plan status current by checking off completed items rather than leaving the plan stale.

---

## Explicit Non-Goals

- [ ] Do not redesign product behavior unless the structural refactor requires it.
- [ ] Do not add backward-compatibility layers unless a task explicitly requires them.
- [ ] Do not treat comment addition as a substitute for simplifying the code itself.
- [ ] Do not postpone obvious structural cleanup just because the current code still works.
