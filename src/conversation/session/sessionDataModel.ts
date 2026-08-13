import { booleanColumn, defineDataDomain, defineTable, integerColumn, jsonColumn, realColumn, textColumn, type DataDomainModel, type DataTableModel } from "#data/model/index.ts";

export const sessionDataDomain = defineDataDomain({
  database: "sessions",
  tableGroup: "sessions.persisted_sessions",
  schemaVersion: 9,
  minReadableSchemaVersion: 6,
  tables: {
    sessions: defineTable({
      table: "sessions",
      primaryKey: ["sessionId"],
      columns: [
        textColumn("sessionId", { title: "Session ID", role: "id", primary: true, storageName: "session_id", notNull: true, checkSql: "session_id = trim(session_id) AND length(session_id) > 0" }),
        textColumn("type", { title: "Type", role: "badge", primary: true, listWidth: "xs", notNull: true, checkSql: "type IN ('private', 'group')" }),
        textColumn("source", { title: "Source", nullable: true, role: "badge", primary: true, listWidth: "xs" }),
        textColumn("modeId", { title: "Mode", nullable: true, storageName: "mode_id" }),
        jsonColumn("operationModeJson", { storageName: "operation_mode_json", nullable: true, hidden: true }),
        textColumn("participantKind", { title: "Participant Kind", storageName: "participant_kind", notNull: true, checkSql: "participant_kind IN ('user', 'group')" }),
        textColumn("participantId", { title: "Participant ID", role: "subtitle", primary: true, storageName: "participant_id", notNull: true }),
        textColumn("title", { title: "Title", nullable: true, role: "title", primary: true, listWidth: "minmax(12rem, 1fr)" }),
        textColumn("titleSource", { title: "Title Source", nullable: true, storageName: "title_source" }),
        textColumn("replyDelivery", { title: "Reply Delivery", nullable: true, storageName: "reply_delivery" }),
        jsonColumn("pacingPreferencesJson", { storageName: "pacing_preferences_json", hidden: true, nullable: true }),
        jsonColumn("toolsetPreferencesJson", { storageName: "toolset_preferences_json", hidden: true, nullable: true }),
        jsonColumn("botProfileJson", { storageName: "bot_profile_json", hidden: true, nullable: true }),
        jsonColumn("pendingMessagesJson", { storageName: "pending_messages_json", hidden: true, notNull: true }),
        jsonColumn("queuedGroupReplyTargetsJson", { storageName: "queued_group_reply_targets_json", hidden: true, notNull: true, defaultSql: "'[]'" }),
        booleanColumn("pendingTranscriptGroupIdIsSet", { storageName: "pending_transcript_group_id_is_set", hidden: true, notNull: true, defaultSql: "0" }),
        textColumn("pendingTranscriptGroupId", { storageName: "pending_transcript_group_id", hidden: true, nullable: true }),
        booleanColumn("activeTranscriptGroupIdIsSet", { storageName: "active_transcript_group_id_is_set", hidden: true, notNull: true, defaultSql: "0" }),
        textColumn("activeTranscriptGroupId", { storageName: "active_transcript_group_id", hidden: true, nullable: true }),
        textColumn("historySummary", { storageName: "history_summary", hidden: true, nullable: true }),
        integerColumn("historyBackfillBoundaryMs", { storageName: "history_backfill_boundary_ms", hidden: true, nullable: true }),
        jsonColumn("taskTrackerJson", { storageName: "task_tracker_json", hidden: true, notNull: true, defaultSql: `'{"version":1,"primary":null,"parked":[]}'` }),
        jsonColumn("debugMarkersJson", { storageName: "debug_markers_json", hidden: true, notNull: true }),
        jsonColumn("lastLlmUsageJson", { storageName: "last_llm_usage_json", hidden: true, nullable: true }),
        jsonColumn("sentMessagesJson", { storageName: "sent_messages_json", hidden: true, notNull: true }),
        integerColumn("lastActiveAtMs", { title: "Last Active", role: "time", primary: true, storageName: "last_active_at_ms", notNull: true }),
        integerColumn("lastMessageAtMs", { title: "Last Message", nullable: true, role: "time", storageName: "last_message_at_ms" }),
        integerColumn("latestGapMs", { storageName: "latest_gap_ms", hidden: true, nullable: true }),
        realColumn("smoothedGapMs", { storageName: "smoothed_gap_ms", hidden: true, nullable: true }),
        integerColumn("updatedAtMs", { title: "Updated", role: "time", storageName: "updated_at_ms", notNull: true }),
        integerColumn("transcriptCount", {
          title: "Transcript Items",
          role: "badge",
          primary: true,
          listWidth: "sm",
          storage: "computed",
          selectSql: `(SELECT COUNT(*) FROM session_transcript_items WHERE session_transcript_items.session_id = sessions.session_id)`
        })
      ],
      defaultSort: [{ column: "lastActiveAtMs", direction: "desc" }],
      list: {
        titleColumn: "title",
        fallbackTitleColumn: "sessionId",
        subtitleColumns: ["sessionId", "participantId"],
        badgeColumns: ["type", "source", "transcriptCount"],
        timeColumn: "updatedAtMs"
      },
      detail: {
        columns: [
          "sessionId",
          "title",
          "type",
          "source",
          "modeId",
          "participantKind",
          "participantId",
          "replyDelivery",
          "transcriptCount",
          "lastActiveAtMs",
          "lastMessageAtMs",
          "updatedAtMs"
        ]
      },
      children: [{
        resourceKey: "session_transcript_items",
        title: "Transcript",
        parentField: "sessionId",
        childField: "sessionId"
      }]
    }),
    session_transcript_items: defineTable({
      table: "session_transcript_items",
      primaryKey: ["sessionId", "itemId"],
      columns: [
        textColumn("sessionId", { title: "Session ID", role: "id", storageName: "session_id", notNull: true }),
        integerColumn("itemIndex", { title: "Index", role: "badge", primary: true, listWidth: "xs", storageName: "item_index", notNull: true, checkSql: "item_index >= 0" }),
        textColumn("itemId", { title: "Item ID", role: "id", primary: true, storageName: "item_id", notNull: true, checkSql: "item_id = trim(item_id) AND length(item_id) > 0" }),
        textColumn("groupId", { title: "Group ID", storageName: "group_id", notNull: true }),
        textColumn("kind", { title: "Kind", role: "title", primary: true, notNull: true }),
        textColumn("role", { title: "Role", nullable: true, role: "badge", primary: true, listWidth: "xs" }),
        booleanColumn("llmVisible", { title: "LLM Visible", role: "badge", primary: true, listWidth: "sm", storageName: "llm_visible", notNull: true, checkSql: "llm_visible IN (0, 1)" }),
        booleanColumn("runtimeExcluded", { title: "Runtime Excluded", role: "badge", primary: true, listWidth: "sm", storageName: "runtime_excluded", notNull: true, checkSql: "runtime_excluded IN (0, 1)" }),
        integerColumn("timestampMs", { title: "Timestamp", role: "time", primary: true, storageName: "timestamp_ms", notNull: true }),
        textColumn("itemHash", { title: "Hash", storageName: "item_hash", notNull: true }),
        jsonColumn("item", { title: "Payload", role: "payload", storageName: "item_json", notNull: true }),
        integerColumn("updatedAtMs", { title: "Updated", storageName: "updated_at_ms", hidden: true, notNull: true })
      ],
      unique: [["sessionId", "itemIndex"]],
      foreignKeys: [{
        columns: ["sessionId"],
        referencesTable: "sessions",
        referencesColumns: ["session_id"],
        onDelete: "CASCADE"
      }],
      indexes: [
        { name: "idx_session_transcript_items_session_index", columns: ["sessionId", "itemIndex"] },
        { name: "idx_session_transcript_items_kind_time", columns: ["kind", "timestampMs"] }
      ],
      defaultSort: [{ column: "itemIndex", direction: "asc" }],
      list: {
        titleColumn: "kind",
        fallbackTitleColumn: "itemId",
        subtitleColumns: ["role", "itemId"],
        badgeColumns: ["itemIndex", "llmVisible", "runtimeExcluded"],
        timeColumn: "timestampMs"
      },
      detail: {
        columns: ["sessionId", "itemIndex", "itemId", "groupId", "kind", "role", "llmVisible", "runtimeExcluded", "timestampMs", "itemHash"],
        payloadColumns: ["item"]
      }
    })
  }
});

export const scenarioHostStateDataDomain = defineDataDomain({
  database: "sessions",
  tableGroup: "sessions.scenario_host_state",
  schemaVersion: 4,
  resetPolicy: "block_reset",
  tables: {
    scenario_host_session_states: defineTable({
      table: "scenario_host_session_states",
      primaryKey: ["sessionId"],
      columns: [
        textColumn("sessionId", { title: "Session ID", role: "id", primary: true, storageName: "session_id", notNull: true }),
        jsonColumn("state", { title: "State", role: "payload", storageName: "state_json", notNull: true }),
        integerColumn("updatedAtMs", { title: "Updated", role: "time", primary: true, storageName: "updated_at_ms", notNull: true })
      ],
      defaultSort: [{ column: "updatedAtMs", direction: "desc" }],
      detail: { payloadColumns: ["state"] }
    })
  }
});

export const sessionsTableModel = requireDataTable("sessions");
export const sessionTranscriptItemsTableModel = requireDataTable("session_transcript_items");
export const scenarioHostSessionStatesTableModel = requireDomainTable(scenarioHostStateDataDomain, "scenario_host_session_states");

function requireDataTable(key: string): DataTableModel {
  const table = sessionDataDomain.tables[key];
  if (!table) {
    throw new Error(`Missing ${key} data model`);
  }
  return table;
}

function requireDomainTable(domain: DataDomainModel, key: string): DataTableModel {
  const table = domain.tables[key];
  if (!table) {
    throw new Error(`Missing ${key} data model`);
  }
  return table;
}
