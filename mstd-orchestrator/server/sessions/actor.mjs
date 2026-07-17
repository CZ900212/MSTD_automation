export function createActorPool() {
  const tails = new Map(); // sessionKey -> Promise
  function enqueue(sessionKey, asyncFn) {
    const tail = tails.get(sessionKey) ?? Promise.resolve();
    const run = tail.then(() => asyncFn());
    const guarded = run.catch(() => {});          // 吞掉尾部错误，队列继续
    tails.set(sessionKey, guarded);
    guarded.then(() => { if (tails.get(sessionKey) === guarded) tails.delete(sessionKey); });
    return run;
  }
  return { enqueue };
}
