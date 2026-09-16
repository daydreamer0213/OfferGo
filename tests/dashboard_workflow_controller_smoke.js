"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createWorkflowController } = require("../src/dashboard/workflow_controller");

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const calls = [];
  const service = {
    async start(input, context) {
      calls.push(["start", input, context]);
      return { workflow: { id: "workflow-started" } };
    },
    async resume(input, context) {
      calls.push(["resume", input, context]);
      if (input.scopeChoice) return { workflow: { id: input.workflowRunId }, scopeChange: null };
      return {
        workflow: { id: input.workflowRunId },
        scopeChange: { expectedScopeToken: "scope-token" }
      };
    },
    async control(input, context) {
      calls.push(["control", input, context]);
      return { workflowRunId: input.workflowRunId, action: input.action };
    },
    status(workflowRunId) {
      calls.push(["status", workflowRunId]);
      return { statusCode: 200, body: { workflow: { id: workflowRunId, status: "scanning" } } };
    }
  };
  const errors = [];
  const controller = createWorkflowController({
    service,
    logger: quietLogger(),
    renderUiError(res, error, back, context) {
      errors.push({ error, back, context });
      res.writeHead(error.statusCode || 409, { "content-type": "text/html" });
      res.end(`error:${error.code}:${back}`);
    }
  });

  const started = responseRecorder();
  await controller.start(request("planId=7&site=boss"), started, { requestId: "request-start" });
  assert.equal(started.statusCode, 303);
  assert.equal(started.headers.location, "/workflow?runId=workflow-started");
  assert.deepEqual(calls[0], ["start", { planId: "7", site: "boss" }, { requestId: "request-start" }]);

  const scope = responseRecorder();
  await controller.resume(
    request("workflowRunId=workflow-existing&browserMode=edge"),
    scope,
    { requestId: "request-resume" }
  );
  assert.equal(scope.statusCode, 409);
  assert.match(scope.body, /搜索条件已经变化/);
  assert.match(scope.body, /scope-token/);
  assert.match(scope.body, /workflow-existing/);

  const resumed = responseRecorder();
  await controller.resume(
    request("workflowRunId=workflow-existing&browserMode=edge&scopeChoice=original"),
    resumed,
    { requestId: "request-resume-choice" }
  );
  assert.equal(resumed.statusCode, 303);
  assert.equal(resumed.headers.location, "/workflow?runId=workflow-existing");

  const controlled = responseRecorder();
  await controller.control(
    request("workflowRunId=workflow-existing&action=pause"),
    controlled,
    { requestId: "request-control" }
  );
  assert.equal(controlled.statusCode, 303);
  assert.equal(controlled.headers.location, "/workflow?runId=workflow-existing");

  const status = responseRecorder();
  controller.status(status, "workflow-existing");
  assert.equal(status.statusCode, 200);
  assert.deepEqual(JSON.parse(status.body), {
    workflow: { id: "workflow-existing", status: "scanning" }
  });

  const failing = createWorkflowController({
    service: {
      async start() {
        throw Object.assign(new Error("model missing"), {
          code: "MODEL_CONFIGURATION_REQUIRED",
          statusCode: 409
        });
      },
      async resume() {
        throw Object.assign(new Error("resume failed"), {
          code: "WORKFLOW_RUN_NOT_FOUND",
          statusCode: 404
        });
      },
      async control() {
        throw Object.assign(new Error("model missing"), {
          code: "MODEL_CONFIGURATION_REQUIRED",
          statusCode: 409
        });
      },
      status() {
        return { statusCode: 404, body: { errorCode: "WORKFLOW_RUN_NOT_FOUND" } };
      }
    },
    logger: quietLogger(),
    renderUiError(res, error, back) {
      res.writeHead(error.statusCode, { "content-type": "text/html" });
      res.end(back);
    }
  });
  const startFailure = responseRecorder();
  await failing.start(request("planId=9&site=boss"), startFailure, { requestId: "request-start-fail" });
  assert.equal(startFailure.statusCode, 409);
  assert.equal(startFailure.body, "/settings#model-profile-batch_screening");

  const resumeFailure = responseRecorder();
  await failing.resume(request("workflowRunId=missing"), resumeFailure, { requestId: "request-resume-fail" });
  assert.equal(resumeFailure.statusCode, 404);
  assert.equal(resumeFailure.body, "/workflow?runId=missing");

  const controlFailure = responseRecorder();
  await failing.control(
    request("workflowRunId=workflow-existing&action=resume"),
    controlFailure,
    { requestId: "request-control-fail" }
  );
  assert.equal(controlFailure.statusCode, 409);
  const controlBody = JSON.parse(controlFailure.body);
  assert.equal(controlBody.errorCode, "MODEL_CONFIGURATION_REQUIRED");
  assert.equal(controlBody.settingsHref, "/settings#model-profile-batch_screening");
  assert.equal(controlBody.requestId, "request-control-fail");
  assert.equal(errors.length, 0);

  console.log("dashboard_workflow_controller_smoke ok");
}

function request(body, contentType = "application/x-www-form-urlencoded") {
  const req = Readable.from([body]);
  req.headers = { "content-type": contentType };
  return req;
}

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers || {};
    },
    end(body = "") {
      this.body = String(body);
    }
  };
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
