export type ToolExecutionEffect =
  | {
      kind: "parallel";
      reads?: readonly string[];
      writes?: readonly string[];
    }
  | {
      kind: "barrier";
    }
  | {
      kind: "terminal_barrier";
    };

export interface ToolExecutionResult<TCall, TResult> {
  index: number;
  call: TCall;
  result: TResult;
}

export interface ExecuteToolCallsWithDependenciesInput<TCall, TResult> {
  calls: readonly TCall[];
  analyze: (call: TCall, index: number) => ToolExecutionEffect;
  execute: (call: TCall, index: number) => Promise<TResult>;
  isTerminalResult?: (result: TResult, call: TCall, index: number) => boolean;
  maxConcurrency?: number;
}

interface ExecutionNode<TCall> {
  index: number;
  call: TCall;
  effect: ToolExecutionEffect;
  dependents: number[];
  remainingDependencies: number;
}

export async function executeToolCallsWithDependencies<TCall, TResult>(
  input: ExecuteToolCallsWithDependenciesInput<TCall, TResult>
): Promise<Array<ToolExecutionResult<TCall, TResult>>> {
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency);
  if (input.calls.length === 0) {
    return [];
  }
  if (input.calls.length === 1 || maxConcurrency <= 1) {
    return executeSerial(input);
  }

  const nodes = buildExecutionGraph(input.calls, input.analyze);
  if (!hasParallelCandidate(nodes)) {
    return executeSerialAnalyzed(input, nodes);
  }

  return executeGraph(input, nodes, maxConcurrency);
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value == null) {
    return 4;
  }
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

async function executeSerial<TCall, TResult>(
  input: ExecuteToolCallsWithDependenciesInput<TCall, TResult>
): Promise<Array<ToolExecutionResult<TCall, TResult>>> {
  const results: Array<ToolExecutionResult<TCall, TResult>> = [];
  for (let index = 0; index < input.calls.length; index += 1) {
    const call = input.calls[index]!;
    const result = await input.execute(call, index);
    results.push({ index, call, result });
    if (input.isTerminalResult?.(result, call, index)) {
      break;
    }
  }
  return results;
}

async function executeSerialAnalyzed<TCall, TResult>(
  input: ExecuteToolCallsWithDependenciesInput<TCall, TResult>,
  nodes: Array<ExecutionNode<TCall>>
): Promise<Array<ToolExecutionResult<TCall, TResult>>> {
  const results: Array<ToolExecutionResult<TCall, TResult>> = [];
  for (const node of nodes) {
    const result = await input.execute(node.call, node.index);
    results.push({ index: node.index, call: node.call, result });
    if (input.isTerminalResult?.(result, node.call, node.index)) {
      break;
    }
  }
  return results;
}

function buildExecutionGraph<TCall>(
  calls: readonly TCall[],
  analyze: (call: TCall, index: number) => ToolExecutionEffect
): Array<ExecutionNode<TCall>> {
  const nodes: Array<ExecutionNode<TCall>> = calls.map((call, index) => ({
    index,
    call,
    effect: analyze(call, index),
    dependents: [],
    remainingDependencies: 0
  }));

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (!effectsConflict(nodes[left]!.effect, nodes[right]!.effect)) {
        continue;
      }
      nodes[left]!.dependents.push(right);
      nodes[right]!.remainingDependencies += 1;
    }
  }

  return nodes;
}

function hasParallelCandidate<TCall>(nodes: Array<ExecutionNode<TCall>>): boolean {
  return nodes.some((node, index) =>
    node.effect.kind === "parallel"
    && nodes.some((other, otherIndex) =>
      otherIndex !== index
      && other.effect.kind === "parallel"
      && !effectsConflict(node.effect, other.effect)
    )
  );
}

function effectsConflict(left: ToolExecutionEffect, right: ToolExecutionEffect): boolean {
  if (left.kind !== "parallel" || right.kind !== "parallel") {
    return true;
  }

  return intersects(left.writes, right.writes)
    || intersects(left.writes, right.reads)
    || intersects(left.reads, right.writes);
}

function intersects(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right || left.length === 0 || right.length === 0) {
    return false;
  }
  return left.some(leftValue => right.some(rightValue => resourceKeysConflict(leftValue, rightValue)));
}

function resourceKeysConflict(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return wildcardMatches(left, right) || wildcardMatches(right, left);
}

function wildcardMatches(pattern: string, value: string): boolean {
  if (!pattern.endsWith(":*")) {
    return false;
  }
  const prefix = pattern.slice(0, -1);
  return value.startsWith(prefix);
}

function executeGraph<TCall, TResult>(
  input: ExecuteToolCallsWithDependenciesInput<TCall, TResult>,
  nodes: Array<ExecutionNode<TCall>>,
  maxConcurrency: number
): Promise<Array<ToolExecutionResult<TCall, TResult>>> {
  return new Promise((resolve, reject) => {
    const ready = nodes
      .filter(node => node.remainingDependencies === 0)
      .map(node => node.index);
    const results: Array<ToolExecutionResult<TCall, TResult>> = [];
    let running = 0;
    let completed = 0;
    let stopped = false;
    let rejected = false;

    const schedule = () => {
      if (rejected) {
        return;
      }
      if ((stopped || completed === nodes.length) && running === 0) {
        resolve(results.sort((left, right) => left.index - right.index));
        return;
      }

      ready.sort((left, right) => left - right);
      while (!stopped && running < maxConcurrency && ready.length > 0) {
        const index = ready.shift()!;
        const node = nodes[index]!;
        running += 1;
        Promise.resolve(input.execute(node.call, node.index))
          .then(result => {
            running -= 1;
            completed += 1;
            results.push({ index: node.index, call: node.call, result });

            if (input.isTerminalResult?.(result, node.call, node.index)) {
              stopped = true;
              schedule();
              return;
            }

            for (const dependent of node.dependents) {
              const dependentNode = nodes[dependent]!;
              dependentNode.remainingDependencies -= 1;
              if (dependentNode.remainingDependencies === 0) {
                ready.push(dependent);
              }
            }
            schedule();
          })
          .catch(error => {
            rejected = true;
            reject(error);
          });
      }
    };

    schedule();
  });
}
