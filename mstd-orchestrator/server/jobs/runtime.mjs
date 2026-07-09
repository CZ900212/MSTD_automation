export function createRuntimeRegistry() {
  const active = new Map(); // jobId -> { client, abort }
  return {
    register(jobId, handle) { active.set(jobId, handle); },
    get(jobId) { return active.get(jobId) ?? null; },
    remove(jobId) { active.delete(jobId); },
    has(jobId) { return active.has(jobId); },
  };
}
