import {
  booleanColumn,
  defineDataDomain,
  defineTable,
  integerColumn,
  jsonColumn,
  textColumn,
  type DataDomainModel,
  type DataTableModel
} from "#data/model/index.ts";

export const requestsDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.requests",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    pending_requests: defineTable({
      table: "pending_requests",
      primaryKey: ["flag"],
      columns: [
        textColumn("flag", { title: "Flag", role: "id", primary: true, notNull: true }),
        textColumn("kind", { title: "Kind", role: "badge", primary: true, notNull: true, listWidth: "xs" }),
        textColumn("userId", { title: "User", role: "subtitle", primary: true, storageName: "user_id", notNull: true }),
        textColumn("groupId", { title: "Group", role: "subtitle", primary: true, storageName: "group_id", nullable: true }),
        textColumn("subType", { title: "Sub Type", role: "badge", storageName: "sub_type", nullable: true, listWidth: "xs" }),
        textColumn("comment", { title: "Comment", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true }),
        integerColumn("sortOrder", { title: "Sort Order", storageName: "sort_order", notNull: true, hidden: true })
      ],
      defaultSort: [{ column: "sortOrder", direction: "asc" }, { column: "flag", direction: "asc" }]
    })
  }
});

export const scheduledJobsDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.scheduled_jobs",
  schemaVersion: 2,
  tables: {
    scheduled_jobs: defineTable({
      table: "scheduled_jobs",
      primaryKey: ["id"],
      columns: [
        textColumn("id", { title: "ID", role: "id", primary: true, notNull: true }),
        textColumn("name", { title: "Name", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        booleanColumn("enabled", { title: "Enabled", role: "status", primary: true, notNull: true, listWidth: "xs" }),
        integerColumn("createdAtMs", { title: "Created", role: "time", storageName: "created_at_ms", notNull: true }),
        integerColumn("updatedAtMs", { title: "Updated", role: "time", primary: true, storageName: "updated_at_ms", notNull: true }),
        jsonColumn("schedule", { title: "Schedule", role: "payload", storage: "computed" }),
        textColumn("instruction", { title: "Instruction", role: "payload", notNull: true }),
        jsonColumn("targets", { title: "Targets", role: "payload", storage: "computed" }),
        jsonColumn("state", { title: "State", role: "payload", storage: "computed" }),
        integerColumn("sortOrder", { title: "Sort Order", storageName: "sort_order", notNull: true, hidden: true })
      ],
      defaultSort: [{ column: "sortOrder", direction: "asc" }, { column: "id", direction: "asc" }],
      detail: {
        payloadColumns: ["schedule", "targets", "state", "instruction"]
      },
      children: [{
        resourceKey: "scheduled_job_targets",
        title: "Targets",
        parentField: "id",
        childField: "jobId"
      }]
    }),
    scheduled_job_targets: defineTable({
      table: "scheduled_job_targets",
      primaryKey: ["jobId", "sessionId"],
      columns: [
        textColumn("jobId", { title: "Job ID", role: "id", primary: true, storageName: "job_id", notNull: true }),
        textColumn("sessionId", { title: "Session", role: "title", primary: true, storageName: "session_id", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("sortOrder", { title: "Sort Order", role: "badge", primary: true, storageName: "sort_order", notNull: true, listWidth: "xs" })
      ],
      defaultSort: [{ column: "jobId", direction: "asc" }, { column: "sortOrder", direction: "asc" }]
    })
  }
});

export const rulesDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.rules",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    global_rules: defineTable({
      table: "global_rules",
      primaryKey: ["id"],
      columns: [
        textColumn("id", { title: "ID", role: "id", primary: true, notNull: true }),
        textColumn("title", { title: "Title", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("kind", { title: "Kind", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("source", { title: "Source", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("content", { title: "Content", role: "payload", notNull: true }),
        integerColumn("createdAt", { title: "Created", role: "time", storageName: "created_at_ms", notNull: true }),
        integerColumn("updatedAt", { title: "Updated", role: "time", primary: true, storageName: "updated_at_ms", notNull: true }),
        integerColumn("sortOrder", { title: "Sort Order", storageName: "sort_order", notNull: true, hidden: true })
      ],
      defaultSort: [{ column: "sortOrder", direction: "asc" }, { column: "id", direction: "asc" }],
      detail: { payloadColumns: ["content"] }
    }),
    toolset_rules: defineTable({
      table: "toolset_rules",
      primaryKey: ["id"],
      columns: [
        textColumn("id", { title: "ID", role: "id", primary: true, notNull: true }),
        textColumn("title", { title: "Title", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        jsonColumn("toolsetIds", { title: "Toolsets", role: "payload", primary: true, storage: "computed", listWidth: "md" }),
        textColumn("source", { title: "Source", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("fingerprint", { title: "Fingerprint", notNull: true }),
        textColumn("content", { title: "Content", role: "payload", notNull: true }),
        integerColumn("createdAt", { title: "Created", role: "time", storageName: "created_at_ms", notNull: true }),
        integerColumn("updatedAt", { title: "Updated", role: "time", primary: true, storageName: "updated_at_ms", notNull: true }),
        integerColumn("sortOrder", { title: "Sort Order", storageName: "sort_order", notNull: true, hidden: true })
      ],
      defaultSort: [{ column: "sortOrder", direction: "asc" }, { column: "id", direction: "asc" }],
      detail: { payloadColumns: ["toolsetIds", "content"] },
      children: [{
        resourceKey: "toolset_rule_toolsets",
        title: "Toolsets",
        parentField: "id",
        childField: "ruleId"
      }]
    }),
    toolset_rule_toolsets: defineTable({
      table: "toolset_rule_toolsets",
      primaryKey: ["ruleId", "toolsetId"],
      columns: [
        textColumn("ruleId", { title: "Rule ID", role: "id", primary: true, storageName: "rule_id", notNull: true }),
        textColumn("toolsetId", { title: "Toolset", role: "title", primary: true, storageName: "toolset_id", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("sortOrder", { title: "Sort Order", role: "badge", primary: true, storageName: "sort_order", notNull: true, listWidth: "xs" })
      ],
      defaultSort: [{ column: "ruleId", direction: "asc" }, { column: "sortOrder", direction: "asc" }]
    })
  }
});

export const userIdentitiesDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.user_identities",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    user_identities: defineTable({
      table: "user_identities",
      primaryKey: ["channelId", "scope", "externalId"],
      columns: [
        textColumn("channelId", { title: "Channel", role: "badge", primary: true, storageName: "channel_id", notNull: true }),
        textColumn("scope", { title: "Scope", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("externalId", { title: "External ID", role: "id", primary: true, storageName: "external_id", notNull: true }),
        textColumn("internalUserId", { title: "Internal User", role: "title", primary: true, storageName: "internal_user_id", notNull: true }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true })
      ],
      unique: [["internalUserId"]],
      defaultSort: [{ column: "channelId", direction: "asc" }, { column: "externalId", direction: "asc" }]
    })
  }
});

export const groupMembershipDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.group_membership",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    group_membership_entries: defineTable({
      table: "group_membership_entries",
      primaryKey: ["groupId", "userId"],
      columns: [
        textColumn("groupId", { title: "Group", role: "id", primary: true, storageName: "group_id", notNull: true }),
        textColumn("userId", { title: "User", role: "title", primary: true, storageName: "user_id", notNull: true }),
        booleanColumn("isMember", { title: "Member", role: "status", primary: true, storageName: "is_member", notNull: true, listWidth: "xs" }),
        integerColumn("verifiedAt", { title: "Verified", role: "time", primary: true, storageName: "verified_at_ms", notNull: true })
      ],
      defaultSort: [{ column: "groupId", direction: "asc" }, { column: "userId", direction: "asc" }]
    })
  }
});

export const usersDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.users",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    users: defineTable({
      table: "users",
      primaryKey: ["userId"],
      columns: [
        textColumn("userId", { title: "User ID", role: "id", primary: true, storageName: "user_id", notNull: true }),
        textColumn("preferredAddress", { title: "Preferred Address", role: "title", primary: true, storageName: "preferred_address", nullable: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("gender", { title: "Gender", role: "badge", primary: true, nullable: true, listWidth: "xs" }),
        textColumn("timezone", { title: "Timezone", role: "badge", primary: true, nullable: true, listWidth: "sm" }),
        textColumn("specialRole", { title: "Special Role", role: "badge", primary: true, storageName: "special_role", nullable: true, listWidth: "sm" }),
        textColumn("residence", { title: "Residence", nullable: true }),
        textColumn("occupation", { title: "Occupation", nullable: true }),
        textColumn("profileSummary", { title: "Profile Summary", role: "payload", storageName: "profile_summary", nullable: true }),
        textColumn("relationshipNote", { title: "Relationship Note", role: "payload", storageName: "relationship_note", nullable: true }),
        jsonColumn("memories", { title: "Memories", role: "payload", storage: "computed" }),
        integerColumn("createdAt", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true })
      ],
      defaultSort: [{ column: "userId", direction: "asc" }],
      detail: { payloadColumns: ["profileSummary", "relationshipNote", "memories"] },
      children: [{
        resourceKey: "user_memories",
        title: "Memories",
        parentField: "userId",
        childField: "userId"
      }]
    }),
    user_memories: defineTable({
      table: "user_memories",
      primaryKey: ["userId", "id"],
      columns: [
        textColumn("userId", { title: "User ID", role: "id", primary: true, storageName: "user_id", notNull: true }),
        textColumn("id", { title: "Memory ID", role: "id", primary: true, notNull: true }),
        textColumn("title", { title: "Title", role: "title", primary: true, notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("kind", { title: "Kind", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("source", { title: "Source", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        integerColumn("importance", { title: "Importance", role: "badge", nullable: true, listWidth: "xs" }),
        textColumn("content", { title: "Content", role: "payload", notNull: true }),
        integerColumn("createdAt", { title: "Created", role: "time", storageName: "created_at_ms", notNull: true }),
        integerColumn("updatedAt", { title: "Updated", role: "time", primary: true, storageName: "updated_at_ms", notNull: true }),
        integerColumn("lastUsedAt", { title: "Last Used", role: "time", storageName: "last_used_at_ms", nullable: true })
      ],
      defaultSort: [{ column: "userId", direction: "asc" }, { column: "createdAt", direction: "asc" }, { column: "id", direction: "asc" }],
      detail: { payloadColumns: ["content"] }
    })
  }
});

export const whitelistDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.whitelist",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    whitelist_entries: defineTable({
      table: "whitelist_entries",
      primaryKey: ["targetType", "targetId"],
      columns: [
        textColumn("targetType", { title: "Type", role: "badge", primary: true, storageName: "target_type", notNull: true, listWidth: "xs" }),
        textColumn("targetId", { title: "Target", role: "title", primary: true, storageName: "target_id", notNull: true, listWidth: "minmax(12rem, 1fr)" }),
        integerColumn("createdAtMs", { title: "Created", role: "time", primary: true, storageName: "created_at_ms", notNull: true })
      ],
      defaultSort: [{ column: "targetType", direction: "asc" }, { column: "targetId", direction: "asc" }]
    })
  }
});

export const runtimeResourcesDataDomain = defineDataDomain({
  database: "state",
  tableGroup: "state.runtime_resources",
  schemaVersion: 1,
  resetPolicy: "block_reset",
  tables: {
    runtime_resources: defineTable({
      table: "runtime_resources",
      primaryKey: ["resourceId"],
      columns: [
        textColumn("resourceId", { title: "Resource ID", role: "id", primary: true, storageName: "resource_id", notNull: true }),
        textColumn("kind", { title: "Kind", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("status", { title: "Status", role: "status", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("ownerSessionId", { title: "Session", role: "subtitle", primary: true, storageName: "owner_session_id", nullable: true }),
        textColumn("title", { title: "Title", role: "title", primary: true, nullable: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("description", { title: "Description", nullable: true }),
        textColumn("summary", { title: "Summary", role: "payload", notNull: true }),
        integerColumn("createdAtMs", { title: "Created", role: "time", storageName: "created_at_ms", notNull: true }),
        integerColumn("lastAccessedAtMs", { title: "Last Accessed", role: "time", primary: true, storageName: "last_accessed_at_ms", notNull: true }),
        integerColumn("expiresAtMs", { title: "Expires", role: "time", storageName: "expires_at_ms", nullable: true }),
        jsonColumn("browserPage", { title: "Browser Page", role: "payload", storage: "computed" }),
        jsonColumn("shellSession", { title: "Shell Session", role: "payload", storage: "computed" })
      ],
      defaultSort: [{ column: "lastAccessedAtMs", direction: "desc" }],
      detail: { payloadColumns: ["summary", "browserPage", "shellSession"] },
      children: [
        {
          resourceKey: "runtime_browser_pages",
          title: "Browser Page",
          parentField: "resourceId",
          childField: "resourceId"
        },
        {
          resourceKey: "runtime_shell_sessions",
          title: "Shell Session",
          parentField: "resourceId",
          childField: "resourceId"
        }
      ]
    }),
    runtime_browser_pages: defineTable({
      table: "runtime_browser_pages",
      primaryKey: ["resourceId"],
      columns: [
        textColumn("resourceId", { title: "Resource ID", role: "id", primary: true, storageName: "resource_id", notNull: true }),
        textColumn("requestedUrl", { title: "Requested URL", role: "title", primary: true, storageName: "requested_url", notNull: true, listWidth: "minmax(16rem, 1fr)" }),
        textColumn("resolvedUrl", { title: "Resolved URL", storageName: "resolved_url", notNull: true }),
        textColumn("backend", { title: "Backend", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        textColumn("title", { title: "Title", role: "subtitle", primary: true, nullable: true }),
        textColumn("profileId", { title: "Profile", role: "badge", storageName: "profile_id", nullable: true, listWidth: "sm" })
      ],
      defaultSort: [{ column: "resourceId", direction: "asc" }]
    }),
    runtime_shell_sessions: defineTable({
      table: "runtime_shell_sessions",
      primaryKey: ["resourceId"],
      columns: [
        textColumn("resourceId", { title: "Resource ID", role: "id", primary: true, storageName: "resource_id", notNull: true }),
        textColumn("command", { title: "Command", role: "title", primary: true, notNull: true, listWidth: "minmax(16rem, 1fr)" }),
        textColumn("cwd", { title: "CWD", role: "subtitle", primary: true, notNull: true }),
        textColumn("shell", { title: "Shell", role: "badge", primary: true, notNull: true, listWidth: "sm" }),
        booleanColumn("tty", { title: "TTY", role: "badge", primary: true, notNull: true, listWidth: "xs" }),
        booleanColumn("login", { title: "Login", role: "badge", primary: true, notNull: true, listWidth: "xs" })
      ],
      defaultSort: [{ column: "resourceId", direction: "asc" }]
    })
  }
});

export const requestsTableModel = requireDomainTable(requestsDataDomain, "pending_requests");
export const scheduledJobsTableModel = requireDomainTable(scheduledJobsDataDomain, "scheduled_jobs");
export const scheduledJobTargetsTableModel = requireDomainTable(scheduledJobsDataDomain, "scheduled_job_targets");
export const globalRulesTableModel = requireDomainTable(rulesDataDomain, "global_rules");
export const toolsetRulesTableModel = requireDomainTable(rulesDataDomain, "toolset_rules");
export const toolsetRuleToolsetsTableModel = requireDomainTable(rulesDataDomain, "toolset_rule_toolsets");
export const userIdentitiesTableModel = requireDomainTable(userIdentitiesDataDomain, "user_identities");
export const groupMembershipTableModel = requireDomainTable(groupMembershipDataDomain, "group_membership_entries");
export const usersTableModel = requireDomainTable(usersDataDomain, "users");
export const userMemoriesTableModel = requireDomainTable(usersDataDomain, "user_memories");
export const whitelistTableModel = requireDomainTable(whitelistDataDomain, "whitelist_entries");
export const runtimeResourcesTableModel = requireDomainTable(runtimeResourcesDataDomain, "runtime_resources");
export const runtimeBrowserPagesTableModel = requireDomainTable(runtimeResourcesDataDomain, "runtime_browser_pages");
export const runtimeShellSessionsTableModel = requireDomainTable(runtimeResourcesDataDomain, "runtime_shell_sessions");

function requireDomainTable(domain: DataDomainModel, key: string): DataTableModel {
  const table = domain.tables[key];
  if (!table) {
    throw new Error(`Missing ${key} data model`);
  }
  return table;
}
