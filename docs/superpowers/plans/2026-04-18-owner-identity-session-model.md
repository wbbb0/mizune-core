# Owner Identity And Session Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 owner、普通用户、外部身份和 session 入口彻底拆开，落地新的内部用户模型、session id 规则和 WebUI owner 会话创建逻辑。

**Architecture:** 新增 `userIdentityStore` 作为“外部身份 -> 内部用户”的唯一映射层，`userStore` 只维护内部用户。session id 统一改成 `<channelId>:<p|g>:<platformId>`，session 的参与者字段改成表达“内部用户”与“群入口”两个不同概念，消息入口链路先解析外部身份，再进入 user / memory / prompt。

**Tech Stack:** Node.js 20、TypeScript、Zod、Vue 3、Pinia、现有 test harness

---

## File Map

- Create: `src/identity/userIdentitySchema.ts`
- Create: `src/identity/userIdentityStore.ts`
- Modify: `src/identity/userStore.ts`
- Modify: `src/identity/whitelistSchema.ts`
- Modify: `src/identity/whitelistStore.ts`
- Modify: `src/app/bootstrap/appSetupSupport.ts`
- Modify: `src/app/messaging/messageContextBuilder.ts`
- Modify: `src/services/onebot/eventRouter.ts`
- Modify: `src/conversation/session/sessionIdentity.ts`
- Modify: `src/conversation/session/sessionStateFactory.ts`
- Modify: `src/conversation/session/sessionTypes.ts`
- Modify: `src/conversation/session/sessionPersistence.ts`
- Modify: `src/internalApi/routeSupport.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `webui/src/components/sessions/CreateSessionDialog.vue`
- Modify: `webui/src/stores/sessions.ts`
- Modify: `webui/src/api/sessions.ts`
- Modify: `test/identity/whitelist-features.test.tsx`
- Modify: `test/session/session-identity.test.tsx`
- Modify: `test/session/persistence.test.tsx`
- Modify: `test/messaging/direct-command-features.test.tsx`
- Modify: `test/messaging/message-steer.test.tsx`
- Modify: `test/webui/...` 与 `test/internalApi/...` 中受 session / create-session 影响的测试

### Task 1: 建立外部身份绑定层

**Files:**
- Create: `src/identity/userIdentitySchema.ts`
- Create: `src/identity/userIdentityStore.ts`
- Test: `test/identity/user-identity-features.test.tsx`

- [ ] **Step 1: 写失败测试，覆盖 owner 绑定、一对一约束和普通用户自动分配内部 id**

```ts
await runCase("identity store binds one external identity to owner", async () => {
  const store = new UserIdentityStore(dataDir, logger);
  await store.init();

  const bound = await store.bindOwnerIdentity({
    channelId: "qqbot",
    externalId: "10001"
  });

  assert.equal(bound.internalUserId, "owner");
  assert.equal((await store.findInternalUserId({
    channelId: "qqbot",
    externalId: "10001"
  })), "owner");
});

await runCase("identity store creates opaque ids for unknown users", async () => {
  const created = await store.ensureUserIdentity({
    channelId: "qqbot",
    externalId: "20002"
  });

  assert.match(created.internalUserId, /^u_[0-9A-HJKMNP-TV-Z]+$/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/identity/user-identity-features.test.tsx`  
Expected: FAIL，提示 `UserIdentityStore` 或相关文件不存在

- [ ] **Step 3: 写最小实现**

```ts
export interface UserIdentityRecord {
  channelId: string;
  scope: "private_user";
  externalId: string;
  internalUserId: string;
  createdAt: number;
}

export class UserIdentityStore {
  async bindOwnerIdentity(input: { channelId: string; externalId: string }) {
    return this.bind({
      channelId: input.channelId,
      scope: "private_user",
      externalId: input.externalId,
      internalUserId: "owner"
    });
  }

  async ensureUserIdentity(input: { channelId: string; externalId: string }) {
    const existing = await this.findRecord(input);
    if (existing) return existing;
    return this.bind({
      channelId: input.channelId,
      scope: "private_user",
      externalId: input.externalId,
      internalUserId: `u_${ulid()}`
    });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/identity/user-identity-features.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/identity/userIdentitySchema.ts src/identity/userIdentityStore.ts test/identity/user-identity-features.test.tsx
git commit -m "feat: add external user identity store"
```

### Task 2: 把 owner 与用户关系从 whitelist 中剥离

**Files:**
- Modify: `src/identity/userStore.ts`
- Modify: `src/identity/whitelistSchema.ts`
- Modify: `src/identity/whitelistStore.ts`
- Modify: `src/app/bootstrap/appSetupSupport.ts`
- Modify: `src/services/onebot/eventRouter.ts`
- Test: `test/identity/whitelist-features.test.tsx`
- Test: `test/messaging/direct-command-features.test.tsx`

- [ ] **Step 1: 写失败测试，要求 whitelist 不再保存 ownerId，`.own` 通过身份绑定完成 owner 认领**

```ts
await runCase("whitelist snapshot no longer exposes ownerId", async () => {
  const store = new WhitelistStore(dataDir, logger);
  await store.init();
  assert.deepEqual(store.getSnapshot(), { users: [], groups: [] });
});

await runCase(".own binds requester identity to owner", async () => {
  const result = await support.assignOwner({
    requesterUserId: "10001",
    targetUserId: "10001",
    chatType: "private",
    channelId: "qqbot"
  });

  assert.match(result, /已将你设为管理者/);
  assert.equal(await identityStore.findInternalUserId({ channelId: "qqbot", externalId: "10001" }), "owner");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/identity/whitelist-features.test.tsx test/messaging/direct-command-features.test.tsx`  
Expected: FAIL，原因是现有 API 仍依赖 `ownerId`

- [ ] **Step 3: 写最小实现**

```ts
function resolveStoredRelationship(userId: string): Relationship {
  return userId === "owner" ? "owner" : "known";
}

export class WhitelistStore {
  getSnapshot(): WhitelistSnapshot {
    return { users: [...this.current.users], groups: [...this.current.groups] };
  }
}

await userStore.ensureInternalUser("owner");
await userIdentityStore.bindOwnerIdentity({
  channelId: params.channelId,
  externalId: params.targetUserId
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/identity/whitelist-features.test.tsx test/messaging/direct-command-features.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/identity/userStore.ts src/identity/whitelistSchema.ts src/identity/whitelistStore.ts src/app/bootstrap/appSetupSupport.ts src/services/onebot/eventRouter.ts test/identity/whitelist-features.test.tsx test/messaging/direct-command-features.test.tsx
git commit -m "refactor: decouple owner binding from whitelist"
```

### Task 3: 重构 session id 与 session participant 语义

**Files:**
- Modify: `src/conversation/session/sessionIdentity.ts`
- Modify: `src/conversation/session/sessionTypes.ts`
- Modify: `src/conversation/session/sessionStateFactory.ts`
- Modify: `src/conversation/session/sessionPersistence.ts`
- Test: `test/session/session-identity.test.tsx`
- Test: `test/session/persistence.test.tsx`

- [ ] **Step 1: 写失败测试，要求 session id 使用 `<channelId>:<p|g>:<platformId>`，私聊 participant 指向内部用户**

```ts
await runCase("build helpers generate channel-scoped chat session ids", async () => {
  assert.equal(buildPrivateSessionId("qqbot", "10001"), "qqbot:p:10001");
  assert.equal(buildGroupSessionId("qqbot", "20001"), "qqbot:g:20001");
});

await runCase("private session state keeps internal participant user id", async () => {
  const session = createSessionState({
    id: "qqbot:p:10001",
    type: "private",
    source: "onebot",
    participantUserId: "owner"
  });

  assert.equal(session.participantUserId, "owner");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/session/session-identity.test.tsx test/session/persistence.test.tsx`  
Expected: FAIL，旧 helper 仍生成 `private:` / `group:`

- [ ] **Step 3: 写最小实现**

```ts
export function buildPrivateSessionId(channelId: string, userId: string): string {
  return `${channelId}:p:${userId}`;
}

export function buildGroupSessionId(channelId: string, groupId: string): string {
  return `${channelId}:g:${groupId}`;
}

export interface SessionParticipantRef {
  kind: "user" | "group";
  internalUserId?: string;
  externalRef: string;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/session/session-identity.test.tsx test/session/persistence.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/conversation/session/sessionIdentity.ts src/conversation/session/sessionTypes.ts src/conversation/session/sessionStateFactory.ts src/conversation/session/sessionPersistence.ts test/session/session-identity.test.tsx test/session/persistence.test.tsx
git commit -m "refactor: adopt channel scoped session ids"
```

### Task 4: 让消息入口先解析外部身份再进入内部用户

**Files:**
- Modify: `src/app/messaging/messageContextBuilder.ts`
- Modify: `src/app/runtime/messageIngress.ts`
- Modify: `src/app/bootstrap/bootstrapServices.ts`
- Test: `test/messaging/message-steer.test.tsx`
- Test: `test/messaging/web-message-context.test.tsx`

- [ ] **Step 1: 写失败测试，要求普通外部用户先解析或创建内部用户 id，再注入消息上下文**

```ts
await runCase("message context resolves inbound external user to internal user", async () => {
  const context = await createMessageProcessingContext(services, incoming, {
    channelId: "qqbot"
  });

  assert.match(context.user.userId, /^u_|^owner$/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/messaging/message-steer.test.tsx test/messaging/web-message-context.test.tsx`  
Expected: FAIL，现有代码直接使用 `incomingMessage.userId`

- [ ] **Step 3: 写最小实现**

```ts
const internalUserId = await services.userIdentityStore.resolveOrCreate({
  channelId: options.channelId,
  externalId: incomingMessage.userId
});

const user = await services.userStore.touchSeenUser({
  userId: internalUserId
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/messaging/message-steer.test.tsx test/messaging/web-message-context.test.tsx`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/messaging/messageContextBuilder.ts src/app/runtime/messageIngress.ts src/app/bootstrap/bootstrapServices.ts test/messaging/message-steer.test.tsx test/messaging/web-message-context.test.tsx
git commit -m "refactor: resolve inbound users through identity store"
```

### Task 5: 删除 WebUI 手填用户 id，固定 owner Web 会话

**Files:**
- Modify: `src/internalApi/routeSupport.ts`
- Modify: `src/internalApi/application/basicAdminService.ts`
- Modify: `webui/src/components/sessions/CreateSessionDialog.vue`
- Modify: `webui/src/stores/sessions.ts`
- Modify: `webui/src/api/sessions.ts`
- Test: `test/internalApi/features.test.tsx`
- Test: `test/webui/sessions/...`

- [ ] **Step 1: 写失败测试，要求 create-session body 不再需要 `participantUserId`，并且 UI 不再出现该输入框**

```ts
await runCase("create web session defaults to owner participant", async () => {
  const result = await createWebSession(deps, { modeId: "rp_assistant" });
  assert.equal(result.session.participantUserId, "owner");
});
```

```tsx
it("create session dialog no longer renders participant user id input", async () => {
  render(CreateSessionDialog, { props: { open: true, modes } });
  expect(screen.queryByLabelText("用户 ID")).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/run-all-tests.mjs test/internalApi/features.test.tsx test/webui/sessions`  
Expected: FAIL，现有接口和表单仍要求 `participantUserId`

- [ ] **Step 3: 写最小实现**

```ts
const createSessionBodySchema = z.object({
  participantLabel: z.string().trim().min(1).optional(),
  modeId: z.string().trim().min(1).optional()
});

const session = deps.sessionManager.ensureSession({
  id: createWebSessionId(),
  type: "private",
  source: "web",
  participantUserId: "owner"
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/run-all-tests.mjs test/internalApi/features.test.tsx test/webui/sessions`  
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/internalApi/routeSupport.ts src/internalApi/application/basicAdminService.ts webui/src/components/sessions/CreateSessionDialog.vue webui/src/stores/sessions.ts webui/src/api/sessions.ts test/internalApi/features.test.tsx test/webui
git commit -m "feat: default web sessions to owner"
```

### Task 6: 全量验证并整理本地 owner 迁移步骤

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-18-owner-identity-session-model-design.md`
- Create: `docs/owner-local-migration-notes.md`

- [ ] **Step 1: 写验证清单与本地 owner 迁移说明**

```md
1. 备份两个 instance 的 `data/<instance>/`
2. 记录旧 owner QQ 号
3. 将 owner 资料与记忆合并到内部用户 `owner`
4. 写入新的 `user-identities.json`
5. 修正 owner 私聊 session id 为 `<channelId>:p:<platformId>`
```

- [ ] **Step 2: 运行完整验证**

Run: `npm run typecheck:all`  
Expected: PASS

Run: `npm test`  
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add README.md docs/owner-local-migration-notes.md
git commit -m "docs: add owner migration notes"
```

