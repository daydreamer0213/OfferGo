const ZHAOPIN_ORIGIN = "https://www.zhaopin.com";
const ZHAOPIN_SEARCH_PATH = "/jobs/";
const TRACKING_PARAMS = new Set(["from", "source", "src", "trackId", "lid", "ref", "refer", "_", "timestamp"]);
const PAGING_PARAMS = new Set(["page", "pageNum"]);
const SEARCH_PARAMS = new Set(["pageMode", "jl", "sl", "el", "we", "ct", "cs", "et", "kw", ...TRACKING_PARAMS, ...PAGING_PARAMS]);
const DEFAULT_FILTER_LABELS = new Set([
  "地区", "薪资", "学历", "经验", "公司性质", "融资阶段", "公司人数", "工作性质", "职位类别", "公司行业"
]);

function selectedZhaopinFilters(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => String(value || "").replace(/\s+/g, " ").trim())
    .filter(value => value && !DEFAULT_FILTER_LABELS.has(value));
}

function zhaopinSearchDisplaySummary(values) {
  const labels = (Array.isArray(values) ? values : []).map(value => String(value || "").replace(/\s+/g, " ").trim());
  const location = labels[0] && labels[0] !== "地区" ? labels[0].replace(/^(?:地点|城市|区域)：/, "") : "不限";
  const names = ["", "薪资", "学历", "经验", "公司性质", "融资阶段", "公司人数", "工作性质", "职位类别", "公司行业"];
  const others = labels.length === names.length
    ? labels.slice(1).flatMap((value, index) => value && !DEFAULT_FILTER_LABELS.has(value) ? [`${names[index + 1]}：${value}`] : [])
    : selectedZhaopinFilters(labels.slice(1));
  return [`地点：${location}`, ...others, ...(others.length ? [] : ["其余条件不限"])].join(" · ");
}

function canonicalizeZhaopinSearchTemplate(rawUrl) {
  const url = parseZhaopinUrl(rawUrl, "ZHAOPIN_SEARCH_PAGE_INVALID", "当前标签页不是可用的智联搜索页。");
  if (url.pathname !== ZHAOPIN_SEARCH_PATH || url.searchParams.get("pageMode") !== "search") {
    throw scopeError("ZHAOPIN_SEARCH_PAGE_INVALID", "当前标签页不是可用的智联搜索页。");
  }
  const params = new URLSearchParams();
  for (const [name, value] of url.searchParams.entries()) {
    if (name.startsWith("utm_") || TRACKING_PARAMS.has(name) || PAGING_PARAMS.has(name) || name === "kw") continue;
    if (!SEARCH_PARAMS.has(name)) {
      throw scopeError("ZHAOPIN_SEARCH_PARAM_UNSUPPORTED", `智联搜索条件“${name}”尚未验证，不能安全继承。`);
    }
    params.append(name, value);
  }
  if (params.get("pageMode") !== "search") {
    throw scopeError("ZHAOPIN_SEARCH_PAGE_INVALID", "当前标签页不是可用的智联搜索页。");
  }
  const canonical = new URL(ZHAOPIN_SEARCH_PATH, ZHAOPIN_ORIGIN);
  for (const name of [...new Set(params.keys())].sort()) {
    for (const value of params.getAll(name).sort()) canonical.searchParams.append(name, value);
  }
  return { mode: "inherited", url: canonical.toString(), cityCode: canonical.searchParams.get("jl") || "" };
}

function buildZhaopinSearchUrl({ keyword, searchTemplate } = {}) {
  const normalizedKeyword = String(keyword || "").trim();
  if (!normalizedKeyword) throw scopeError("ZHAOPIN_KEYWORD_REQUIRED", "智联搜索需要非空关键词。");
  const template = canonicalizeZhaopinSearchTemplate(searchTemplate?.url || searchTemplate);
  const url = new URL(template.url);
  url.searchParams.set("kw", normalizedKeyword);
  return url.toString();
}

function zhaopinJobIdentity(rawUrl) {
  const url = parseZhaopinUrl(rawUrl, "ZHAOPIN_JOB_URL_INVALID", "不是可用的智联岗位详情链接。");
  const match = url.pathname.match(/^\/jobdetail\/([A-Za-z0-9]+)\.htm$/);
  if (!match) throw scopeError("ZHAOPIN_JOB_URL_INVALID", "不是可用的智联岗位详情链接。");
  for (const name of [...url.searchParams.keys()]) {
    if (name.startsWith("utm_") || TRACKING_PARAMS.has(name)) url.searchParams.delete(name);
  }
  url.hash = "";
  return { source: "zhaopin", sourceId: match[1], url: url.toString() };
}

function parseZhaopinUrl(rawUrl, code, message) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (cause) {
    throw scopeError(code, message, cause);
  }
  if (url.origin !== ZHAOPIN_ORIGIN || url.protocol !== "https:" || url.username || url.password) {
    throw scopeError(code, message);
  }
  return url;
}

function scopeError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

module.exports = { canonicalizeZhaopinSearchTemplate, buildZhaopinSearchUrl, zhaopinJobIdentity, selectedZhaopinFilters, zhaopinSearchDisplaySummary };
