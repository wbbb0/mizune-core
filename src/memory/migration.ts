import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readStructuredFileRaw, writeConfigFile } from "#data/schema/file.ts";
import { normalizeUserProfilePatch } from "#identity/userProfile.ts";
import { userStoreSchema } from "#identity/userSchema.ts";
import { createToolsetRuleEntry, type ToolsetRuleEntry } from "#llm/prompt/toolsetRuleStore.ts";
import { createGlobalRuleEntry, type GlobalRuleEntry } from "#memory/globalRuleEntry.ts";
import { detectScopeConflict } from "#memory/memoryCategory.ts";
import {
  findBestDuplicateMatch,
  normalizeTextForSimilarity,
  normalizeTitleForDedup
} from "#memory/similarity.ts";
import { createUserMemoryEntry, type UserMemoryEntry, type UserMemoryKind } from "#memory/userMemoryEntry.ts";
import { createEmptyPersona, personaSchema, type Persona } from "#persona/personaSchema.ts";

const USERS_FILE = "users.json";
const PERSONA_FILE = "persona.json";
const GLOBAL_RULES_FILE = "global-rules.json";
const TOOLSET_RULES_FILE = "toolset-rules.json";
const LEGACY_GLOBAL_RULES_FILE = "global-memories.json";
const LEGACY_TOOLSET_RULES_FILE = "operation-notes.json";
const REPORT_FILE = "memory-migration-report.json";

export interface MemoryMigrationDuplicate {
  category: "user_memories" | "global_rules" | "toolset_rules";
  keptId: string;
  droppedId: string;
  title: string;
  reason: "exact_or_near_duplicate";
}

export interface MemoryMigrationScopeFinding {
  category: "persona" | "user_memories" | "global_rules" | "toolset_rules";
  title: string;
  suggestedScope: string;
  reason: string;
}

export interface MemoryMigrationInventory {
  users: number;
  userMemories: number;
  globalRules: number;
  toolsetRules: number;
  legacyGlobalRules: number;
  legacyToolsetRules: number;
  legacyPersonaMemories: number;
}

export interface MemoryMigrationReport {
  dataDir: string;
  inventory: MemoryMigrationInventory;
  duplicates: MemoryMigrationDuplicate[];
  scopeFindings: MemoryMigrationScopeFinding[];
  filesWritten: string[];
  filesRemoved: string[];
}

type RawObject = Record<string, unknown>;

function asObject(value: unknown): RawObject | null {
  return typeof value === "object" && value !== null ? value as RawObject : null;
}

function asObjectArray(value: unknown): RawObject[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is RawObject => Boolean(item)) : [];
}

function getString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => getString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function readLegacyUserMemories(value: unknown): RawObject[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is RawObject => Boolean(item)) : [];
}

function inferUserMemoryKind(title: string, content: string): UserMemoryKind {
  const text = `${title}\n${content}`;
  if (/(不要|别|禁止|不能|边界|忌讳)/u.test(text)) {
    return "boundary";
  }
  if (/(偏好|喜欢|讨厌|希望|想要|爱吃|不喜欢)/u.test(text)) {
    return "preference";
  }
  if (/(关系|对象|伴侣|家人|朋友|同事)/u.test(text)) {
    return "relationship";
  }
  if (/(习惯|经常|常常|平时|作息)/u.test(text)) {
    return "habit";
  }
  if (/(住在|来自|生日|工作|职业|时区|学校|城市)/u.test(text)) {
    return "fact";
  }
  return "other";
}

function inferGlobalRuleKind(title: string, content: string): GlobalRuleEntry["kind"] {
  const text = `${title}\n${content}`;
  if (/(不要|禁止|必须|仅在|严禁|禁止)/u.test(text)) {
    return "constraint";
  }
  if (/(偏好|优先|倾向|先给结论)/u.test(text)) {
    return "preference";
  }
  if (/(流程|步骤|默认|一般情况下|平时|所有任务)/u.test(text)) {
    return "workflow";
  }
  return "other";
}

function mapLegacyUserMemorySource(value: unknown): UserMemoryEntry["source"] {
  const source = getString(value);
  if (source === "owner" || source === "owner_explicit") {
    return "owner_explicit";
  }
  if (source === "inferred" || source === "model") {
    return "inferred";
  }
  return "user_explicit";
}

function mapLegacyGlobalRuleSource(value: unknown): GlobalRuleEntry["source"] {
  const source = getString(value);
  return source === "inferred" || source === "model" ? "inferred" : "owner_explicit";
}

function dedupeUserMemories(memories: UserMemoryEntry[]) {
  const kept: UserMemoryEntry[] = [];
  const duplicates: MemoryMigrationDuplicate[] = [];
  for (const memory of memories) {
    const duplicate = findBestDuplicateMatch(
      `${normalizeTitleForDedup(memory.title)} ${memory.content}`,
      kept,
      (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
    );
    if (!duplicate) {
      kept.push(memory);
      continue;
    }
    const preferred = duplicate.item.updatedAt >= memory.updatedAt ? duplicate.item : memory;
    const dropped = preferred.id === duplicate.item.id ? memory : duplicate.item;
    if (preferred.id !== duplicate.item.id) {
      const index = kept.findIndex((item) => item.id === duplicate.item.id);
      kept[index] = preferred;
    }
    duplicates.push({
      category: "user_memories",
      keptId: preferred.id,
      droppedId: dropped.id,
      title: preferred.title,
      reason: "exact_or_near_duplicate"
    });
  }
  return { kept, duplicates };
}

function dedupeGlobalRules(rules: GlobalRuleEntry[]) {
  const kept: GlobalRuleEntry[] = [];
  const duplicates: MemoryMigrationDuplicate[] = [];
  for (const rule of rules) {
    const duplicate = findBestDuplicateMatch(
      `${normalizeTitleForDedup(rule.title)} ${rule.content}`,
      kept,
      (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
    );
    if (!duplicate) {
      kept.push(rule);
      continue;
    }
    const preferred = duplicate.item.updatedAt >= rule.updatedAt ? duplicate.item : rule;
    const dropped = preferred.id === duplicate.item.id ? rule : duplicate.item;
    if (preferred.id !== duplicate.item.id) {
      const index = kept.findIndex((item) => item.id === duplicate.item.id);
      kept[index] = preferred;
    }
    duplicates.push({
      category: "global_rules",
      keptId: preferred.id,
      droppedId: dropped.id,
      title: preferred.title,
      reason: "exact_or_near_duplicate"
    });
  }
  return { kept, duplicates };
}

function haveOverlappingToolsets(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function dedupeToolsetRules(rules: ToolsetRuleEntry[]) {
  const kept: ToolsetRuleEntry[] = [];
  const duplicates: MemoryMigrationDuplicate[] = [];
  for (const rule of rules) {
    const duplicate = findBestDuplicateMatch(
      `${normalizeTitleForDedup(rule.title)} ${rule.content}`,
      kept.filter((item) => haveOverlappingToolsets(item.toolsetIds, rule.toolsetIds)),
      (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
    );
    if (!duplicate) {
      kept.push(rule);
      continue;
    }
    const preferred = duplicate.item.updatedAt >= rule.updatedAt ? duplicate.item : rule;
    const dropped = preferred.id === duplicate.item.id ? rule : duplicate.item;
    if (preferred.id !== duplicate.item.id) {
      const index = kept.findIndex((item) => item.id === duplicate.item.id);
      kept[index] = preferred;
    }
    duplicates.push({
      category: "toolset_rules",
      keptId: preferred.id,
      droppedId: dropped.id,
      title: preferred.title,
      reason: "exact_or_near_duplicate"
    });
  }
  return { kept, duplicates };
}

function mapLegacyPersonaMemoryToField(entry: { title: string; content: string }): keyof Persona {
  const text = `${entry.title}\n${entry.content}`;
  if (/(口吻|语气|说话方式|说话风格)/u.test(text)) {
    return "speakingStyle";
  }
  if (/(性格|气质|人设|定位)/u.test(text)) {
    return "temperament";
  }
  if (/(偏好|习惯|喜好|审美|倾向)/u.test(text)) {
    return "generalPreferences";
  }
  return "globalTraits";
}

function mergePersonaField(current: string, incoming: string): string {
  const compactCurrent = normalizeTextForSimilarity(current);
  const compactIncoming = normalizeTextForSimilarity(incoming);
  if (!current.trim()) {
    return incoming.trim();
  }
  if (!incoming.trim() || compactCurrent.includes(compactIncoming) || compactIncoming.includes(compactCurrent)) {
    return current.trim();
  }
  return `${current.trim()}；${incoming.trim()}`;
}

function migratePersona(raw: unknown) {
  const reportFindings: MemoryMigrationScopeFinding[] = [];
  const promotedGlobalRules: GlobalRuleEntry[] = [];
  const obj = asObject(raw);
  if (!obj) {
    return {
      persona: createEmptyPersona(),
      findings: reportFindings,
      promotedGlobalRules,
      legacyPersonaMemories: 0
    };
  }

  try {
    return {
      persona: personaSchema.parse(obj),
      findings: reportFindings,
      promotedGlobalRules,
      legacyPersonaMemories: 0
    };
  } catch {
    const legacyMemories = readLegacyUserMemories(obj.memories);
    let persona = createEmptyPersona();
    persona = personaSchema.parse({
      name: getString(obj.name) ?? "",
      temperament: [
        getString(obj.temperament),
        getString(obj.personality),
        getString(obj.coreIdentity),
        getString(obj.role),
        getString(obj.identity)
      ].filter((item): item is string => Boolean(item)).join("；"),
      globalTraits: [
        getString(obj.globalTraits),
        getString(obj.interests),
        getString(obj.hobbies),
        getString(obj.likesAndDislikes)
      ].filter((item): item is string => Boolean(item)).join("；"),
      generalPreferences: [
        getString(obj.generalPreferences),
        getString(obj.background),
        getString(obj.appearance),
        getString(obj.virtualAppearance),
        getString(obj.familyBackground),
        getString(obj.residence),
        getString(obj.secrets)
      ].filter((item): item is string => Boolean(item)).join("；"),
      speakingStyle: getString(obj.speakingStyle) ?? getString(obj.speechStyle) ?? ""
    });

    const outputFormatRequirements = getString(obj.outputFormatRequirements);
    if (outputFormatRequirements) {
      promotedGlobalRules.push(createGlobalRuleEntry({
        title: "默认输出要求",
        content: outputFormatRequirements,
        kind: inferGlobalRuleKind("默认输出要求", outputFormatRequirements),
        source: "owner_explicit"
      }));
      reportFindings.push({
        category: "persona",
        title: "默认输出要求",
        suggestedScope: "global_rules",
        reason: "旧 persona 输出格式要求更像跨任务工作流规则，已提升为 global_rules。"
      });
    }

    for (const memory of legacyMemories) {
      const title = getString(memory.title);
      const content = getString(memory.content);
      if (!title || !content) {
        continue;
      }
      const warning = detectScopeConflict({
        currentScope: "persona",
        title,
        content
      });
      if (warning) {
        promotedGlobalRules.push(createGlobalRuleEntry({
          title,
          content,
          kind: inferGlobalRuleKind(title, content),
          source: "owner_explicit",
          ...(getNumber(memory.updatedAt) !== undefined ? { createdAt: getNumber(memory.updatedAt)! } : {}),
          ...(getNumber(memory.updatedAt) !== undefined ? { updatedAt: getNumber(memory.updatedAt)! } : {})
        }));
        reportFindings.push({
          category: "persona",
          title,
          suggestedScope: warning.suggestedScope,
          reason: `${warning.reason} 迁移时已提升为 global_rules。`
        });
        continue;
      }
      const targetField = mapLegacyPersonaMemoryToField({ title, content });
      persona = {
        ...persona,
        [targetField]: mergePersonaField(persona[targetField], `${title}：${content}`)
      };
    }

    return {
      persona: personaSchema.parse(persona),
      findings: reportFindings,
      promotedGlobalRules,
      legacyPersonaMemories: legacyMemories.length
    };
  }
}

function migrateUsers(raw: unknown) {
  const findings: MemoryMigrationScopeFinding[] = [];
  const duplicates: MemoryMigrationDuplicate[] = [];
  const users = asObjectArray(raw).flatMap((item) => {
    const userId = getString(item.userId);
    if (!userId) {
      return [];
    }
    const profilePatchInput: Parameters<typeof normalizeUserProfilePatch>[0] = {};
    const preferredAddress = getString(item.preferredAddress) ?? getString(item.nickname);
    const gender = getString(item.gender);
    const residence = getString(item.residence);
    const timezone = getString(item.timezone);
    const occupation = getString(item.occupation);
    const profileSummary = getString(item.profileSummary);
    const relationshipNote = getString(item.relationshipNote) ?? getString(item.sharedContext);
    if (preferredAddress) profilePatchInput.preferredAddress = preferredAddress;
    if (gender) profilePatchInput.gender = gender;
    if (residence) profilePatchInput.residence = residence;
    if (timezone) profilePatchInput.timezone = timezone;
    if (occupation) profilePatchInput.occupation = occupation;
    if (profileSummary) profilePatchInput.profileSummary = profileSummary;
    if (relationshipNote) profilePatchInput.relationshipNote = relationshipNote;
    const profilePatch = normalizeUserProfilePatch(profilePatchInput);
    const migratedMemories = readLegacyUserMemories(item.memories).flatMap((memory) => {
      const title = getString(memory.title);
      const content = getString(memory.content);
      if (!title || !content) {
        return [];
      }
      const migratedInput: Parameters<typeof createUserMemoryEntry>[0] = {
        title,
        content,
        kind: (getString(memory.kind) as UserMemoryKind | undefined) ?? inferUserMemoryKind(title, content),
        source: mapLegacyUserMemorySource(memory.source)
      };
      const legacyMemoryId = getString(memory.id);
      const legacyCreatedAt = getNumber(memory.createdAt) ?? getNumber(memory.updatedAt);
      const legacyUpdatedAt = getNumber(memory.updatedAt);
      const legacyImportance = getNumber(memory.importance);
      const legacyLastUsedAt = getNumber(memory.lastUsedAt);
      if (legacyMemoryId) migratedInput.id = legacyMemoryId;
      if (legacyCreatedAt !== undefined) migratedInput.createdAt = legacyCreatedAt;
      if (legacyUpdatedAt !== undefined) migratedInput.updatedAt = legacyUpdatedAt;
      if (legacyImportance !== undefined) migratedInput.importance = legacyImportance;
      if (legacyLastUsedAt !== undefined) migratedInput.lastUsedAt = legacyLastUsedAt;
      const migrated = createUserMemoryEntry(migratedInput);
      const warning = detectScopeConflict({
        currentScope: "user_memories",
        title,
        content
      });
      if (warning) {
        findings.push({
          category: "user_memories",
          title,
          suggestedScope: warning.suggestedScope,
          reason: warning.reason
        });
      }
      return [migrated];
    });
    const deduped = dedupeUserMemories(migratedMemories);
    duplicates.push(...deduped.duplicates);
    return [{
      userId,
      ...profilePatch,
      ...(getString(item.specialRole) === "npc" ? { specialRole: "npc" as const } : {}),
      memories: deduped.kept,
      createdAt: getNumber(item.createdAt) ?? Date.now()
    }];
  });

  return {
    users: userStoreSchema.parse(users),
    duplicates,
    findings
  };
}

function migrateGlobalRules(currentRaw: unknown, legacyRaw: unknown, promoted: GlobalRuleEntry[]) {
  const findings: MemoryMigrationScopeFinding[] = [];
  const sourceItems = [
    ...asObjectArray(currentRaw),
    ...asObjectArray(legacyRaw),
    ...promoted.map((item) => item as unknown as RawObject)
  ];
  const rules = sourceItems.flatMap((item) => {
    const title = getString(item.title);
    const content = getString(item.content);
    if (!title || !content) {
      return [];
    }
    const ruleInput: Parameters<typeof createGlobalRuleEntry>[0] = {
      title,
      content,
      kind: (getString(item.kind) as GlobalRuleEntry["kind"] | undefined) ?? inferGlobalRuleKind(title, content),
      source: mapLegacyGlobalRuleSource(item.source)
    };
    const globalRuleId = getString(item.id);
    const globalRuleCreatedAt = getNumber(item.createdAt) ?? getNumber(item.updatedAt);
    const globalRuleUpdatedAt = getNumber(item.updatedAt);
    if (globalRuleId) ruleInput.id = globalRuleId;
    if (globalRuleCreatedAt !== undefined) ruleInput.createdAt = globalRuleCreatedAt;
    if (globalRuleUpdatedAt !== undefined) ruleInput.updatedAt = globalRuleUpdatedAt;
    const rule = createGlobalRuleEntry(ruleInput);
    const warning = detectScopeConflict({
      currentScope: "global_rules",
      title,
      content
    });
    if (warning) {
      findings.push({
        category: "global_rules",
        title,
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      });
    }
    return [rule];
  });
  const deduped = dedupeGlobalRules(rules);
  return {
    rules: deduped.kept,
    duplicates: deduped.duplicates,
    findings
  };
}

function migrateToolsetRules(currentRaw: unknown, legacyRaw: unknown) {
  const findings: MemoryMigrationScopeFinding[] = [];
  const rules = [...asObjectArray(currentRaw), ...asObjectArray(legacyRaw)].flatMap((item) => {
    const title = getString(item.title);
    const content = getString(item.content);
    const toolsetIds = getStringArray(item.toolsetIds);
    if (!title || !content || toolsetIds.length === 0) {
      return [];
    }
    const ruleInput: Parameters<typeof createToolsetRuleEntry>[0] = {
      title,
      content,
      toolsetIds,
      source: getString(item.source) === "inferred" || getString(item.source) === "model" ? "inferred" : "owner_explicit"
    };
    const toolsetRuleId = getString(item.id);
    const toolsetRuleCreatedAt = getNumber(item.createdAt) ?? getNumber(item.updatedAt);
    const toolsetRuleUpdatedAt = getNumber(item.updatedAt);
    if (toolsetRuleId) ruleInput.id = toolsetRuleId;
    if (toolsetRuleCreatedAt !== undefined) ruleInput.createdAt = toolsetRuleCreatedAt;
    if (toolsetRuleUpdatedAt !== undefined) ruleInput.updatedAt = toolsetRuleUpdatedAt;
    const rule = createToolsetRuleEntry(ruleInput);
    const warning = detectScopeConflict({
      currentScope: "toolset_rules",
      title,
      content
    });
    if (warning) {
      findings.push({
        category: "toolset_rules",
        title,
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      });
    }
    return [rule];
  });
  const deduped = dedupeToolsetRules(rules);
  return {
    rules: deduped.kept,
    duplicates: deduped.duplicates,
    findings
  };
}

async function readOptionalStructuredFile(filePath: string): Promise<unknown | null> {
  try {
    return await readStructuredFileRaw(filePath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function migrateMemoryDataDir(input: {
  dataDir: string;
  removeLegacyFiles?: boolean;
}): Promise<MemoryMigrationReport> {
  const usersPath = join(input.dataDir, USERS_FILE);
  const personaPath = join(input.dataDir, PERSONA_FILE);
  const globalRulesPath = join(input.dataDir, GLOBAL_RULES_FILE);
  const toolsetRulesPath = join(input.dataDir, TOOLSET_RULES_FILE);
  const legacyGlobalRulesPath = join(input.dataDir, LEGACY_GLOBAL_RULES_FILE);
  const legacyToolsetRulesPath = join(input.dataDir, LEGACY_TOOLSET_RULES_FILE);
  const reportPath = join(input.dataDir, REPORT_FILE);

  const [
    usersRaw,
    personaRaw,
    globalRulesRaw,
    toolsetRulesRaw,
    legacyGlobalRulesRaw,
    legacyToolsetRulesRaw
  ] = await Promise.all([
    readOptionalStructuredFile(usersPath),
    readOptionalStructuredFile(personaPath),
    readOptionalStructuredFile(globalRulesPath),
    readOptionalStructuredFile(toolsetRulesPath),
    readOptionalStructuredFile(legacyGlobalRulesPath),
    readOptionalStructuredFile(legacyToolsetRulesPath)
  ]);

  const migratedPersona = migratePersona(personaRaw);
  const migratedUsers = migrateUsers(usersRaw ?? []);
  const migratedGlobalRules = migrateGlobalRules(
    globalRulesRaw ?? [],
    legacyGlobalRulesRaw ?? [],
    migratedPersona.promotedGlobalRules
  );
  const migratedToolsetRules = migrateToolsetRules(toolsetRulesRaw ?? [], legacyToolsetRulesRaw ?? []);

  const report: MemoryMigrationReport = {
    dataDir: input.dataDir,
    inventory: {
      users: migratedUsers.users.length,
      userMemories: migratedUsers.users.reduce((sum, user) => sum + user.memories.length, 0),
      globalRules: migratedGlobalRules.rules.length,
      toolsetRules: migratedToolsetRules.rules.length,
      legacyGlobalRules: asObjectArray(legacyGlobalRulesRaw).length,
      legacyToolsetRules: asObjectArray(legacyToolsetRulesRaw).length,
      legacyPersonaMemories: migratedPersona.legacyPersonaMemories
    },
    duplicates: [
      ...migratedUsers.duplicates,
      ...migratedGlobalRules.duplicates,
      ...migratedToolsetRules.duplicates
    ],
    scopeFindings: [
      ...migratedPersona.findings,
      ...migratedUsers.findings,
      ...migratedGlobalRules.findings,
      ...migratedToolsetRules.findings
    ],
    filesWritten: [],
    filesRemoved: []
  };

  await writeConfigFile(usersPath, migratedUsers.users);
  report.filesWritten.push(usersPath);
  await writeConfigFile(personaPath, migratedPersona.persona);
  report.filesWritten.push(personaPath);
  await writeConfigFile(globalRulesPath, migratedGlobalRules.rules);
  report.filesWritten.push(globalRulesPath);
  await writeConfigFile(toolsetRulesPath, migratedToolsetRules.rules);
  report.filesWritten.push(toolsetRulesPath);
  report.filesWritten.push(reportPath);

  if (input.removeLegacyFiles ?? true) {
    for (const filePath of [legacyGlobalRulesPath, legacyToolsetRulesPath]) {
      const raw = await readOptionalStructuredFile(filePath);
      if (raw == null) {
        continue;
      }
      await rm(filePath, { force: true });
      report.filesRemoved.push(filePath);
    }
  }

  await writeConfigFile(reportPath, report);

  return report;
}
