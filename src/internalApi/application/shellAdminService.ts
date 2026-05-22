import type { InternalApiShellDeps } from "../types.ts";
import type {
  ParsedSessionParams,
  ParsedShellInteractBody,
  ParsedShellResizeBody,
  ParsedShellRunBody,
  ParsedShellSignalBody
} from "../routeSupport.ts";

export function listShellSessions(deps: InternalApiShellDeps) {
  return {
    sessions: deps.shellRuntime.listSessions()
  };
}

export function getShellSession(
  deps: InternalApiShellDeps,
  params: ParsedSessionParams
) {
  return deps.shellRuntime.listSessions().find((item) => item.id === params.sessionId) ?? null;
}

export async function runShellCommand(
  deps: InternalApiShellDeps,
  body: ParsedShellRunBody
) {
  return deps.shellRuntime.run({
    command: body.command,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
    ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    ...(body.tty !== undefined ? { tty: body.tty } : {}),
    ...(body.background !== undefined ? { background: body.background } : {})
  });
}

export async function interactWithShellSession(
  deps: InternalApiShellDeps,
  params: ParsedSessionParams,
  body: ParsedShellInteractBody
) {
  return deps.shellRuntime.interact(params.sessionId, body.input);
}

export async function readShellSession(
  deps: InternalApiShellDeps,
  params: ParsedSessionParams
) {
  return deps.shellRuntime.read(params.sessionId);
}

export async function signalShellSession(
  deps: InternalApiShellDeps,
  params: ParsedSessionParams,
  body: ParsedShellSignalBody
) {
  return deps.shellRuntime.signal(params.sessionId, body.signal);
}

export async function resizeShellSession(
  deps: InternalApiShellDeps,
  params: ParsedSessionParams,
  body: ParsedShellResizeBody
) {
  return deps.shellRuntime.resize(params.sessionId, body.cols, body.rows);
}

export function closeShellSession(
  deps: InternalApiShellDeps,
  params: ParsedSessionParams
) {
  deps.shellRuntime.closeSession(params.sessionId);
  return { ok: true };
}
