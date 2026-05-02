import { contextChunk } from "./retriever.mjs";

export function listDemoScenarios() {
  return [
    assistantPreferencesDemo(),
    nasCleanupDemo(),
    adultRpDemo(),
  ];
}

export function getDemoScenario(name) {
  const scenario = listDemoScenarios().find((item) => item.name === name);
  if (!scenario) {
    throw new Error(`unknown demo scenario: ${name}`);
  }
  return scenario;
}

export function defaultDemoName() {
  return "assistant_preferences";
}

export function demoNames() {
  return listDemoScenarios().map((scenario) => scenario.name);
}

function assistantPreferencesDemo() {
  return {
    name: "assistant_preferences",
    title: "Assistant Preferences",
    description: "偏好、称呼、回答风格与轻度噪声混合的基础记忆检索场景。",
    userId: "alice",
    query: "今天给我推荐一杯咖啡，记得怎么称呼我，回答简短一点。",
    systemPrompt: "你是一个演示用助手。请优先利用提供的 retrieved_context 回答用户，但不要编造没有出现过的长期记忆。回答要自然、简短。",
    chunks: [
      chunk("alice-coffee", "alice", "session-1", "chunk", "2026-04-01T09:00:00Z", "如果让我选咖啡，优先无糖拿铁和冷萃，不喜欢太甜。"),
      chunk("alice-address", "alice", "session-2", "chunk", "2026-04-05T09:00:00Z", "以后直接叫我阿斌就行。"),
      chunk("alice-style", "alice", "session-3", "chunk", "2026-04-07T09:00:00Z", "我更喜欢你回答时先给结论，再给简短步骤，不要太啰嗦。"),
      chunk("alice-summary", "alice", "session-4", "summary", "2026-04-09T09:00:00Z", "最近和我相关的稳定偏好是：咖啡偏向无糖，称呼用阿斌，回复风格偏简洁。"),
      chunk("alice-travel-noise", "alice", "session-5", "chunk", "2026-04-10T09:00:00Z", "我下个月去东京出差，机票和酒店都已经订好了。"),
      chunk("alice-nas-noise", "alice", "session-6", "chunk", "2026-04-11T09:00:00Z", "我最近在整理家里的 NAS 和备份方案。"),
      chunk("alice-duplicate-style", "alice", "session-7", "chunk", "2026-04-12T09:00:00Z", "回答尽量先说结论，再给很短的步骤。"),
      chunk("bob-food", "bob", "session-9", "chunk", "2026-04-10T09:00:00Z", "我最爱吃重庆火锅，也接受很辣。"),
      chunk("bob-coffee-confuser", "bob", "session-10", "summary", "2026-04-12T09:00:00Z", "我喜欢无糖冰美式和冷萃。"),
    ],
  };
}

function nasCleanupDemo() {
  return {
    name: "nas_cleanup",
    title: "NAS Cleanup",
    description: "路径、保留策略、安全边界与清理命令规划并存的复杂任务记忆场景。",
    userId: "owner",
    query: "帮我清一下 NAS 下载区，重点找 /mnt/nas/downloads 里超过 30 天、体积大的旧包。先给 dry-run 命令和判断依据，不要直接删除。",
    systemPrompt: "你是一个演示用助手。请把 retrieved_context 当成当前用户的长期工作约定。如果用户在说 NAS 清理，优先给计划、dry-run 命令和风险说明，默认不要直接执行危险动作。",
    chunks: [
      chunk("nas-root", "owner", "ops-1", "chunk", "2026-03-01T09:00:00Z", "NAS 下载主目录在 /mnt/nas/downloads，临时下载目录在 /mnt/nas/incoming。"),
      chunk("nas-policy", "owner", "ops-2", "summary", "2026-03-08T09:00:00Z", "你清理 NAS 时默认先 dry-run，不要直接 rm；超过 30 天的大文件先列候选，再看是否移到 /mnt/nas/archive/manual-review。"),
      chunk("nas-whitelist", "owner", "ops-3", "chunk", "2026-03-12T09:00:00Z", "保留 .torrent、.aria2、.nfo、.srt 这类文件，不要把它们当成垃圾直接删。"),
      chunk("nas-boundary", "owner", "ops-4", "chunk", "2026-03-16T09:00:00Z", "不要碰 /mnt/nas/media 和 /mnt/nas/photo，NAS 清理默认只动 downloads 和 incoming。"),
      chunk("nas-review", "owner", "ops-5", "chunk", "2026-03-19T09:00:00Z", "遇到压缩包、未确认是否已入库的视频包，先移到 /mnt/nas/archive/manual-review。"),
      chunk("nas-noise-router", "owner", "ops-6", "chunk", "2026-03-22T09:00:00Z", "你下周想升级路由器固件，并顺便调整旁路由策略。"),
      chunk("nas-noise-shell", "owner", "ops-7", "chunk", "2026-03-24T09:00:00Z", "你在 shell 里更喜欢先看 du -sh 最大目录，再决定是否继续细分。"),
      chunk("other-user-cleanup", "friend", "ops-8", "summary", "2026-03-28T09:00:00Z", "我清下载目录时喜欢直接删除 iso 和旧种子，不做人工复核。"),
    ],
  };
}

function adultRpDemo() {
  return {
    name: "adult_rp",
    title: "Adult RP",
    description: "成年人自愿前提下的暧昧角色扮演，强调氛围、边界与语气偏好，不含露骨细节。",
    userId: "partner",
    query: "继续我们昨晚那个成年人角色扮演吧，你先接话，保持暧昧拉扯和一点占有欲，但别突然转露骨。",
    systemPrompt: "你是一个演示用助手。retrieved_context 里会给出角色扮演的偏好和边界。可以写成年人之间自愿、暧昧、带张力的对白，但不要转成露骨性描写，也不要越过明确边界。",
    chunks: [
      chunk("rp-address", "partner", "rp-1", "chunk", "2026-04-01T21:00:00Z", "做角色扮演时你喜欢我叫你'姐姐'，你会叫我'乖一点'或'过来'。"),
      chunk("rp-tone", "partner", "rp-2", "summary", "2026-04-03T21:00:00Z", "你偏好成年人之间自愿、带一点压迫感和拉扯感的暧昧气氛，但整体节奏要慢热。"),
      chunk("rp-boundary", "partner", "rp-3", "chunk", "2026-04-05T21:00:00Z", "不要突然转露骨，不要写器官描写；更偏好耳语、逼近、试探、命令口吻这类暧昧推进。"),
      chunk("rp-consent", "partner", "rp-4", "chunk", "2026-04-06T21:00:00Z", "你强调这类 RP 必须是成年人、双方自愿，而且要保留随时停下来的台词空间。"),
      chunk("rp-noise-food", "partner", "rp-5", "chunk", "2026-04-07T21:00:00Z", "你说周末想吃日料，尤其是寿司和烤物。"),
      chunk("other-rp-confuser", "other", "rp-9", "summary", "2026-04-08T21:00:00Z", "我喜欢非常直白的成人 RP，不需要慢热铺垫。"),
    ],
  };
}

function chunk(chunkId, userId, sessionId, sourceType, createdAt, text) {
  return contextChunk({
    chunkId,
    userId,
    sessionId,
    sourceType,
    createdAt,
    text,
  });
}
