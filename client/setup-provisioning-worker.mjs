import { parentPort, workerData } from "node:worker_threads";

import { applySetupBroker } from "../broker-core/index.mjs";

const cancellationView = new Int32Array(workerData.cancellationBuffer);

function cancellationSignalName() {
  return Atomics.load(cancellationView, 0) === 2 ? "SIGTERM" : "SIGINT";
}

try {
  const result = applySetupBroker(workerData.paths, {
    ...workerData.options,
    getCancellationSignalName: cancellationSignalName,
    isCancelled: () => Atomics.load(cancellationView, 0) !== 0,
  });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    error: {
      message: error?.message ?? String(error),
      payload: error?.payload ?? {
        exitCode: error?.exitCode ?? 1,
        reasonCode: error?.reasonCode ?? "internal-error",
      },
    },
    ok: false,
  });
}
