import test from "node:test";
import assert from "node:assert/strict";
import { SessionTaskTrackerService } from "../../src/conversation/taskTracker/sessionTaskTrackerService.ts";
import { createEmptySessionTaskTracker, type SessionTaskTracker } from "../../src/conversation/taskTracker/taskTrackerTypes.ts";
import type { ToolObservation } from "../../src/conversation/session/toolObservation.ts";

const service = new SessionTaskTrackerService();

test("terminal_run exitCode=0 records progress without completing task", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "terminal_run",
    toolCallId: "call-1",
    content: JSON.stringify({ stdout: "ok", exitCode: 0 }),
    originalRequest: "跑测试",
    nowMs: 1
  });

  assert.equal(tracker.primary?.status, "active");
  assert.notEqual(tracker.primary?.status, "completed");
  assert.match(tracker.primary?.done.join("\n") ?? "", /terminal_run/);
});

test("terminal running result moves task to waiting_tool", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "terminal_start",
    toolCallId: "call-1",
    content: JSON.stringify({ status: "running", resource_id: "res_shell_1" }),
    originalRequest: "启动长任务",
    nowMs: 1
  });

  assert.equal(tracker.primary?.status, "waiting_tool");
  assert.match(tracker.primary?.next.join("\n") ?? "", /等待后台终端/);
});

test("terminal nested running session moves task to waiting_tool", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "terminal_read",
    toolCallId: "call-1",
    content: JSON.stringify({ session: { status: "running", resource_id: "res_shell_1" } }),
    originalRequest: "查看长任务",
    nowMs: 1
  });

  assert.equal(tracker.primary?.status, "waiting_tool");
});

test("terminal successful followup clears waiting terminal next", () => {
  const waiting = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "terminal_start",
    toolCallId: "call-1",
    content: JSON.stringify({ status: "running", resource_id: "res_shell_1" }),
    originalRequest: "启动长任务",
    nowMs: 1
  });

  const completed = service.observeToolResult({
    sessionId: "s1",
    tracker: waiting,
    toolName: "terminal_read",
    toolCallId: "call-2",
    content: JSON.stringify({ session: { status: "closed" }, exitCode: 0, output: "done" }),
    nowMs: 2
  });

  assert.equal(completed.primary?.status, "active");
  assert.doesNotMatch(completed.primary?.next.join("\n") ?? "", /等待后台终端完成/);
});

test("terminal nonzero exit records blocker without completing task", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "terminal_run",
    toolCallId: "call-1",
    content: JSON.stringify({ stderr: "fail", exitCode: 2 }),
    originalRequest: "跑测试",
    nowMs: 1
  });

  assert.equal(tracker.primary?.status, "active");
  assert.match(tracker.primary?.blockers.join("\n") ?? "", /退出码 2/);
});

test("search result records compact summary without storing full results", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "web_search",
    toolCallId: "call-1",
    content: JSON.stringify({
      results: [
        { title: "A", snippet: "FULL_RESULT_SHOULD_NOT_BE_STORED" },
        { title: "B", snippet: "FULL_RESULT_SHOULD_NOT_BE_STORED" }
      ]
    }),
    args: { query: "node latest" },
    originalRequest: "搜索 Node 最新版本",
    nowMs: 1
  });

  const serialized = JSON.stringify(tracker.primary);
  assert.match(tracker.primary?.done.join("\n") ?? "", /已搜索 node latest，返回 2 条结果/);
  assert.doesNotMatch(serialized, /FULL_RESULT_SHOULD_NOT_BE_STORED/);
});

test("browser inspect stores browser resource reference", () => {
  const observation: ToolObservation = {
    contentHash: "hash",
    inputTokensEstimate: 10,
    summary: "页面包含文档标题",
    retention: "summary",
    replayContent: "{}",
    resource: { kind: "browser_page", id: "page-1" },
    replaySafe: true,
    refetchable: true,
    pinned: false
  };
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: createEmptySessionTaskTracker(),
    toolName: "inspect_page",
    toolCallId: "call-1",
    content: JSON.stringify({ ok: true }),
    observation,
    originalRequest: "看网页",
    nowMs: 1
  });

  assert.deepEqual(tracker.primary?.importantToolRefs[0]?.resource, { kind: "browser_page", id: "page-1" });
});

test("assistant final delivery moves active task to ready_to_close only", () => {
  const tracker = service.observeAssistantFinalResponse({
    tracker: trackerWithPrimary({ status: "active", next: [], blockers: [] }),
    text: "测试已经通过，结果如下。",
    nowMs: 10
  });

  assert.equal(tracker.primary?.status, "ready_to_close");
  assert.equal(tracker.primary?.readyToCloseAtMs, 10);
});

test("ambiguous cancel enters cancel_confirming", () => {
  const tracker = service.observeUserBatch({
    tracker: trackerWithPrimary(),
    messages: [{ text: "算了，先这样" }],
    nowMs: 2
  });

  assert.equal(tracker.primary?.status, "cancel_confirming");
});

test("explicit cancel without running resources cancels tracking", () => {
  const tracker = service.observeUserBatch({
    tracker: trackerWithPrimary(),
    messages: [{ text: "不用做了" }],
    hasRunningResources: false,
    nowMs: 2
  });

  assert.equal(tracker.primary?.status, "canceled");
});

test("explicit cancel with running resources asks before stopping resources", () => {
  const tracker = service.observeUserBatch({
    tracker: trackerWithPrimary(),
    messages: [{ text: "取消这个任务" }],
    hasRunningResources: true,
    nowMs: 2
  });

  assert.equal(tracker.primary?.status, "waiting_user");
  assert.match(tracker.primary?.next.join("\n") ?? "", /确认/);
});

test("continue restores suspended task to active", () => {
  const tracker = service.observeUserBatch({
    tracker: trackerWithPrimary({ status: "suspended" }),
    messages: [{ text: "继续刚才的任务" }],
    nowMs: 2
  });

  assert.equal(tracker.primary?.status, "active");
});

test("planner cancel intent asks for confirmation when running resources may exist", () => {
  const tracker = service.observePlannerTaskIntent({
    tracker: trackerWithPrimary(),
    intent: { kind: "cancel_current", confidence: "high", reason: "用户要停掉当前事" },
    hasRunningResources: true,
    nowMs: 3
  });

  assert.equal(tracker.primary?.status, "waiting_user");
  assert.match(tracker.primary?.next.join("\n") ?? "", /停止后台/);
});

test("planner low confidence intent does not mutate task", () => {
  const tracker = service.observePlannerTaskIntent({
    tracker: trackerWithPrimary({ status: "active" }),
    intent: { kind: "cancel_current", confidence: "low" },
    hasRunningResources: false,
    nowMs: 3
  });

  assert.equal(tracker.primary?.status, "active");
});

test("planner continue intent resumes waiting_user task", () => {
  const tracker = service.observePlannerTaskIntent({
    tracker: trackerWithPrimary({ status: "waiting_user", next: ["等待用户选择方案"] }),
    intent: { kind: "modify_current", confidence: "high" },
    hasRunningResources: false,
    nowMs: 3
  });

  assert.equal(tracker.primary?.status, "active");
});

test("planner restore parked intent requires exact target task id", () => {
  const tracker = service.observePlannerTaskIntent({
    tracker: {
      ...trackerWithPrimary({
        taskId: "current-task",
        status: "active",
        objective: "当前任务"
      }),
      parked: [{
        taskId: "parked-task",
        status: "suspended",
        objective: "后台测试",
        summary: "等用户恢复",
        importantToolRefs: [],
        updatedAtMs: 2
      }]
    },
    intent: { kind: "restore_parked", targetTaskId: "parked-task", confidence: "high" },
    nowMs: 3
  });

  assert.equal(tracker.primary?.taskId, "parked-task");
  assert.equal(tracker.primary?.status, "active");
  assert.equal(tracker.parked[0]?.taskId, "current-task");
});

test("new task tool result after completed primary creates a fresh primary", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: trackerWithPrimary({
      taskId: "old-task",
      status: "completed",
      objective: "旧任务",
      done: ["旧任务已完成"]
    }),
    toolName: "terminal_run",
    toolCallId: "call-new",
    content: JSON.stringify({ stdout: "ok", exitCode: 0 }),
    originalRequest: "新的测试任务",
    nowMs: 20
  });

  assert.equal(tracker.primary?.taskId, "s1:20");
  assert.equal(tracker.primary?.objective, "新的测试任务");
  assert.deepEqual(tracker.primary?.done, ["terminal_run: 终端工具执行成功"]);
});

test("failed tool result after canceled primary does not reactivate old task", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: trackerWithPrimary({
      taskId: "old-task",
      status: "canceled",
      objective: "旧任务"
    }),
    toolName: "terminal_run",
    toolCallId: "call-new",
    content: JSON.stringify({ stderr: "fail", exitCode: 2 }),
    originalRequest: "新的失败任务",
    nowMs: 21
  });

  assert.equal(tracker.primary?.taskId, "s1:21");
  assert.equal(tracker.primary?.objective, "新的失败任务");
  assert.equal(tracker.primary?.status, "active");
  assert.match(tracker.primary?.blockers.join("\n") ?? "", /退出码 2/);
});

test("new task tool result after ready_to_close primary creates a fresh primary", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: trackerWithPrimary({
      taskId: "old-task",
      status: "ready_to_close",
      objective: "等待确认的旧任务"
    }),
    toolName: "web_search",
    toolCallId: "call-new",
    content: JSON.stringify({ results: [{ title: "A" }] }),
    args: { query: "新问题" },
    originalRequest: "搜索新问题",
    nowMs: 22
  });

  assert.equal(tracker.primary?.taskId, "s1:22");
  assert.equal(tracker.primary?.objective, "搜索新问题");
  assert.match(tracker.primary?.done.join("\n") ?? "", /已搜索 新问题，返回 1 条结果/);
});

test("new tool task parks old waiting task", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: trackerWithPrimary({
      taskId: "old-task",
      status: "waiting_tool",
      objective: "等待后台测试",
      next: ["等待后台终端完成或继续读取输出。"],
      importantToolRefs: [{
        toolCallId: "old-call",
        toolName: "terminal_start",
        resource: { kind: "shell_session", id: "term-old" },
        createdAtMs: 1
      }]
    }),
    toolName: "web_search",
    toolCallId: "new-call",
    content: JSON.stringify({ results: [{ title: "A" }] }),
    args: { query: "新任务" },
    originalRequest: "搜索新任务",
    nowMs: 30
  });

  assert.equal(tracker.primary?.taskId, "s1:30");
  assert.equal(tracker.primary?.objective, "搜索新任务");
  assert.equal(tracker.parked.length, 1);
  assert.equal(tracker.parked[0]?.taskId, "old-task");
  assert.equal(tracker.parked[0]?.importantToolRefs.length, 1);
});

test("parked task tool callback restores parked task as primary", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: {
      ...trackerWithPrimary({
        taskId: "current-task",
        status: "active",
        objective: "当前任务"
      }),
      parked: [{
        taskId: "parked-task",
        status: "waiting_tool",
        objective: "后台测试",
        summary: "等待后台终端完成",
        importantToolRefs: [{
          toolCallId: "old-call",
          toolName: "terminal_start",
          resource: { kind: "shell_session", id: "term-old" },
          createdAtMs: 1
        }],
        updatedAtMs: 2
      }]
    },
    toolName: "terminal_read",
    toolCallId: "read-old",
    content: JSON.stringify({ session: { status: "closed", resource_id: "term-old" }, exitCode: 0, output: "done" }),
    args: { resource_id: "term-old" },
    nowMs: 31
  });

  assert.equal(tracker.primary?.taskId, "parked-task");
  assert.equal(tracker.primary?.status, "active");
  assert.match(tracker.primary?.done.join("\n") ?? "", /terminal_read/);
  assert.equal(tracker.parked[0]?.taskId, "current-task");
});

test("user mention restores matching parked task", () => {
  const tracker = service.observeUserBatch({
    tracker: {
      ...trackerWithPrimary({
        taskId: "current-task",
        status: "active",
        objective: "当前任务"
      }),
      parked: [{
        taskId: "parked-task",
        status: "suspended",
        objective: "后台测试",
        summary: "等用户恢复",
        importantToolRefs: [],
        updatedAtMs: 2
      }]
    },
    messages: [{ text: "继续后台测试" }],
    nowMs: 32
  });

  assert.equal(tracker.primary?.taskId, "parked-task");
  assert.equal(tracker.primary?.status, "active");
  assert.equal(tracker.parked[0]?.taskId, "current-task");
});

test("parking over limit archives oldest closable parked task first", () => {
  const tracker = service.observeToolResult({
    sessionId: "s1",
    tracker: {
      ...trackerWithPrimary({
        taskId: "old-primary",
        status: "waiting_tool",
        objective: "等待后台任务"
      }),
      parked: [
        {
          taskId: "ready-old",
          status: "ready_to_close",
          objective: "待关闭旧任务",
          summary: "待确认",
          importantToolRefs: [],
          updatedAtMs: 1
        },
        {
          taskId: "active-old",
          status: "active",
          objective: "另一个旧任务",
          summary: "处理中",
          importantToolRefs: [],
          updatedAtMs: 2
        }
      ]
    },
    toolName: "web_search",
    toolCallId: "new-call",
    content: JSON.stringify({ results: [] }),
    args: { query: "新任务" },
    originalRequest: "搜索新任务",
    nowMs: 33
  });

  assert.deepEqual(tracker.parked.map((task) => task.taskId), ["active-old", "old-primary"]);
});

function trackerWithPrimary(overrides: Partial<NonNullable<SessionTaskTracker["primary"]>> = {}): SessionTaskTracker {
  return {
    version: 1,
    primary: {
      taskId: "task-1",
      status: "active",
      objective: "测试任务",
      done: [],
      next: [],
      blockers: [],
      importantToolRefs: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      ...overrides
    },
    parked: []
  };
}
