"use strict";

const { appError, publicError, errorMeta } = require("../core/observability");
const { userFacingError } = require("./user_facing_errors");
const { sendHtml, sendJson, escapeAttr } = require("./http/response");
const { renderPage } = require("./ui/shell");

function createWorkflowController({ service, logger, renderUiError } = {}) {
  if (!service
    || typeof service.start !== "function"
    || typeof service.resume !== "function"
    || typeof service.control !== "function"
    || typeof service.status !== "function") {
    throw new TypeError("workflow controller requires a workflow service");
  }
  if (typeof renderUiError !== "function") {
    throw new TypeError("workflow controller requires renderUiError");
  }

  return { start, resume, control, status };

  async function start(req, res, { requestId = "" } = {}) {
    let planId = 0;
    try {
      const params = await readRequestParams(req);
      planId = Number(params.planId || 0);
      const result = await service.start(params, { requestId });
      if (Array.isArray(result.platformResults)) {
        const partial = result.platformResults.some((item) => item.status === "failed");
        return redirect(res, `/plan?planId=${encodeURIComponent(planId)}&dual=${partial ? "partial" : "started"}`);
      }
      return redirect(res, `/workflow?runId=${encodeURIComponent(result.workflow.id)}`);
    } catch (error) {
      return renderUiError(
        res,
        error,
        modelSettingsBack(error, planId ? `/plan?planId=${planId}` : "/plan"),
        {
          logger,
          requestId,
          event: "workflow_run_start_failed",
          fallbackCode: "WORKFLOW_RUN_START_FAILED"
        }
      );
    }
  }

  async function resume(req, res, { requestId = "" } = {}) {
    let workflowRunId = "";
    try {
      const params = await readRequestParams(req);
      workflowRunId = String(params.workflowRunId || params.runId || "").trim();
      const result = await service.resume(
        { ...params, workflowRunId },
        { requestId }
      );
      if (result.scopeChange) {
        return sendHtml(res, renderWorkflowScopeChoicePage({
          workflowRunId,
          browserMode: params.browserMode,
          cdpPort: params.cdpPort,
          expectedScopeToken: result.scopeChange.expectedScopeToken
        }), 409);
      }
      return redirect(res, `/workflow?runId=${encodeURIComponent(result.workflow.id)}`);
    } catch (error) {
      return renderUiError(
        res,
        error,
        modelSettingsBack(
          error,
          workflowRunId ? `/workflow?runId=${encodeURIComponent(workflowRunId)}` : "/plan"
        ),
        {
          logger,
          requestId,
          event: "workflow_run_resume_failed",
          fallbackCode: "WORKFLOW_RUN_RESUME_FAILED"
        }
      );
    }
  }

  async function control(req, res, { requestId = "" } = {}) {
    let workflowRunId = "";
    let action = "";
    try {
      const params = await readRequestParams(req);
      workflowRunId = String(params.workflowRunId || params.runId || "").trim();
      action = String(params.action || "").trim().toLowerCase();
      await service.control(
        { ...params, workflowRunId, action },
        { requestId }
      );
      return redirect(res, `/workflow?runId=${encodeURIComponent(workflowRunId)}`);
    } catch (error) {
      const issue = publicError(error, {
        fallbackCode: "WORKFLOW_CONTROL_FAILED",
        fallbackMessage: "工作流控制未能完成。",
        statusCode: 409
      });
      logger?.error?.("workflow_control_failed", {
        requestId,
        workflowRunId,
        action,
        error: errorMeta(error),
        errorCode: issue.code
      });
      const guidance = userFacingError(issue.code, issue.message);
      return sendJson(res, issue.statusCode, {
        error: `${guidance.title}：${guidance.impact} ${guidance.nextAction}`,
        errorCode: issue.code,
        requestId,
        ...(issue.code === "MODEL_CONFIGURATION_REQUIRED"
          ? { settingsHref: "/settings#model-profile-batch_screening" }
          : {})
      });
    }
  }

  function status(res, workflowRunId) {
    const result = service.status(String(workflowRunId || ""));
    return sendJson(res, result.statusCode, result.body);
  }
}

function renderWorkflowScopeChoicePage({ workflowRunId, browserMode, cdpPort, expectedScopeToken }) {
  const identity = `<input type="hidden" name="workflowRunId" value="${escapeAttr(workflowRunId)}"><input type="hidden" name="browserMode" value="${escapeAttr(browserMode)}">${cdpPort ? `<input type="hidden" name="cdpPort" value="${Number(cdpPort)}">` : ""}`;
  return renderPage({
    title: "搜索条件已经变化",
    body: `<main><h1>搜索条件已经变化</h1><section class="panel"><p>本轮开始时的条件与当前 BOSS 搜索页不同。旧结果不会与新结果混合。</p><div class="workflow-actions"><form method="post" action="/api/workflow-run/resume">${identity}<input type="hidden" name="scopeChoice" value="new"><input type="hidden" name="expectedScopeToken" value="${escapeAttr(expectedScopeToken)}"><button data-workflow-primary="true">按新条件重新开始本轮</button></form><form method="post" action="/api/workflow-run/resume">${identity}<input type="hidden" name="scopeChoice" value="original"><button class="secondary">继续开始时的条件</button></form><a class="button-link" href="/workflow?runId=${encodeURIComponent(workflowRunId)}">返回本轮</a></div></section></main>`
  });
}

async function readRequestParams(req) {
  const rawBody = await readBody(req);
  return parseBody(rawBody, req.headers?.["content-type"] || "");
}

function parseBody(rawBody, contentType) {
  const text = String(rawBody || "");
  if (String(contentType).includes("application/json")) return text ? JSON.parse(text) : {};
  const result = {};
  for (const [key, value] of new URLSearchParams(text).entries()) {
    if (!(key in result)) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > 64 * 1024) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(appError(
          "REQUEST_BODY_TOO_LARGE",
          "请求内容过大，请返回清单后重新确认。",
          { statusCode: 413 }
        ));
      } else {
        resolve(body);
      }
    });
    req.on("error", reject);
  });
}

function modelSettingsBack(error, fallback) {
  return error?.code === "MODEL_CONFIGURATION_REQUIRED"
    ? "/settings#model-profile-batch_screening"
    : fallback;
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

module.exports = {
  createWorkflowController,
  renderWorkflowScopeChoicePage,
  readRequestParams
};
