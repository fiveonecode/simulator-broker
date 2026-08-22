import { Worker } from "node:worker_threads";

import { BrokerError } from "../broker-core/index.mjs";

const SIGNAL_CODES = Object.freeze({
  SIGINT: 1,
  SIGTERM: 2,
});

function brokerErrorFromWorker(payload) {
  return new BrokerError(payload?.message ?? "Setup provisioning failed.", payload?.payload ?? {
    reasonCode: "internal-error",
  });
}

export function applySetupBrokerInWorker(paths, options, cancellation) {
  const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const cancellationView = new Int32Array(cancellationBuffer);
  const requestCancellation = (signalName) => {
    Atomics.store(cancellationView, 0, SIGNAL_CODES[signalName] ?? SIGNAL_CODES.SIGINT);
    Atomics.notify(cancellationView, 0);
  };
  cancellation.requestProvisioningCancellation = requestCancellation;
  if (cancellation.signalName !== null) {
    requestCancellation(cancellation.signalName);
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./setup-provisioning-worker.mjs", import.meta.url), {
      workerData: {
        cancellationBuffer,
        options: {
          confirmPlanId: options.confirmPlanId,
          hostId: options.hostId ?? undefined,
          iosVersion: options.iosVersion ?? undefined,
        },
        paths,
      },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation.requestProvisioningCancellation = null;
      callback(value);
    };
    worker.once("message", (message) => {
      if (message?.ok === true) {
        finish(resolve, message.result);
        return;
      }
      finish(reject, brokerErrorFromWorker(message?.error));
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      finish(reject, new BrokerError("Setup provisioning worker exited without returning a result.", {
        workerExitCode: code,
        reasonCode: "internal-error",
      }));
    });
  });
}
