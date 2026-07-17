function exited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function signalOwnedGroup(child, signal) {
  if (!child?.pid || exited(child)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalAndWait(child, signal, timeoutMs) {
  if (!child || exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (didExit) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(didExit);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    signalOwnedGroup(child, signal);
  });
}

export async function stopOwnedProcessTree(child, {
  termTimeoutMs = 5000,
  killTimeoutMs = 3000,
} = {}) {
  if (!child || exited(child)) return;
  if (await signalAndWait(child, "SIGTERM", termTimeoutMs)) return;
  if (await signalAndWait(child, "SIGKILL", killTimeoutMs)) return;
  throw new Error(`owned E2E daemon process group did not exit (pid=${child.pid})`);
}
