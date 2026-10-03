const { createHash } = require("node:crypto");
const { isKnownFactKey } = require("./message_reply_contract");

const VALID_SCOPE_KINDS = new Set(["global", "job", "company", "experience"]);

function normalizeReplyDraftText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

function replyDraftDigest(value) {
  return `sha256:${createHash("sha256").update(comparableText(value)).digest("hex")}`;
}

function replyDraftWasEdited(originalText, finalText) {
  return comparableText(originalText) !== comparableText(finalText);
}

function deriveUserChangedText(originalText, finalText) {
  const original = Array.from(normalizeReplyDraftText(originalText));
  const final = Array.from(normalizeReplyDraftText(finalText));
  if (comparableText(original.join("")) === comparableText(final.join(""))) return "";
  let prefix = 0;
  while (prefix < original.length && prefix < final.length && original[prefix] === final[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix
    && suffix < final.length - prefix
    && original[original.length - 1 - suffix] === final[final.length - 1 - suffix]
  ) suffix += 1;
  return final.slice(prefix, final.length - suffix || final.length).join("").slice(0, 2000);
}

function validateReplyEditFactExtraction(value, options = {}) {
  const changedText = options.changedText || "";
  const extraction = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const evidenceSource = String(changedText || "");
  const suppliedScope = Object.hasOwn(options, "scope") ? options.scope : extraction.scope;
  const scopeValue = suppliedScope && typeof suppliedScope === "object" && !Array.isArray(suppliedScope)
    ? suppliedScope
    : {};
  const scope = {
    kind: VALID_SCOPE_KINDS.has(scopeValue.kind) ? scopeValue.kind : "global",
    key: String(scopeValue.key || "").replace(/\s+/g, " ").trim().slice(0, 160)
  };
  const byKey = new Map();
  for (const item of Array.isArray(extraction.facts) ? extraction.facts : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const factKey = String(item.factKey || "").trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
    const factValue = String(item.factValue || "").trim().slice(0, 2000);
    const evidenceText = String(item.evidenceText || "").trim().slice(0, 2000);
    if (!factKey || !isKnownFactKey(factKey) || !factValue || !evidenceText) continue;
    if (!evidenceSource.includes(evidenceText)) continue;
    byKey.set(factKey, { factKey, factValue, evidenceText });
  }
  const experiences = (Array.isArray(extraction.experiences) ? extraction.experiences : []).slice(0, 3).flatMap(item => {
    const subject = String(item?.subject || '').trim();
    const quote = String(item?.sourceQuote || '').trim();
    const finalText = normalizeReplyDraftText(options.finalText || '');
    const editStart = finalText.indexOf(evidenceSource);
    const quoteStart = finalText.indexOf(quote);
    const editedQuoteLength = editStart < 0 || quoteStart < 0 ? 0
      : Math.max(0, Math.min(editStart + evidenceSource.length, quoteStart + quote.length) - Math.max(editStart, quoteStart));
    const overlapsEdit = evidenceSource.includes(quote)
      || editedQuoteLength >= 8
      || (evidenceSource.length > 0 && finalText.includes(quote) && (options.confirmedExperiences || []).some(entry =>
        deriveUserChangedText(entry.sourceQuote, quote) === evidenceSource));
    if (!subject || subject.length > 160 || quote.length < 8 || quote.length > 2000 || !overlapsEdit) return [];
    if (/(?:愿意|可以|接受|承诺|每周).{0,20}(?:你们|贵司|贵公司|这家|该公司).{0,12}(?:办公室|办公|现场|坐班)|(?:你们|贵司|贵公司|这家|该公司).{0,12}(?:办公室|办公|现场|坐班).{0,12}(?:每周|每天|天|愿意|可以|接受|承诺)/.test(quote)) return [];
    if (/(?:期望|预期|希望|要求).{0,8}(?:薪资|薪酬|工资|待遇)|(?:薪资|薪酬|工资|待遇).{0,6}(?:期望|预期|接受|希望)|(?:何时|什么时候|下周|随时|一个月内|两周后|\d+月\d+日).{0,6}(?:到岗|入职)|(?:接受|愿意|可以|能).{0,10}(?:出差|加班|搬迁|异地)|(?:贵司|贵公司|这份岗位|该岗位|这家公司|该公司).{0,15}(?:接受|愿意|可以|能|承诺|每周|办公)/.test(quote)) return [];
    return [{ subject, text: quote, sourceQuote: quote }];
  });
  return { scope, facts: [...byKey.values()], ...(Array.isArray(extraction.experiences) ? { experiences } : {}) };
}

function comparableText(value) {
  return normalizeReplyDraftText(value).replace(/\s+/g, " ").trim();
}

module.exports = {
  normalizeReplyDraftText,
  replyDraftDigest,
  replyDraftWasEdited,
  deriveUserChangedText,
  validateReplyEditFactExtraction
};
