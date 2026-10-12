"use strict";

function formatFieldLines(rows) {
  return rows.map((row) => row.map((value) => {
    const field = String(value ?? "");
    return !field || /[|"\r\n]/.test(field) || field.trim() !== field
      ? `"${field.replace(/"/g, '""')}"` : field;
  }).join(" | ")).join("\n");
}

function parseFieldLines(value, { maxFields, label = "资料" }) {
  const input = String(value ?? "");
  const rows = [];
  let row = [], field = "", state = "start", present = false;
  const invalid = () => {
    const error = new Error(`${label}的列数或引号格式不正确，请重新打开资料页检查后保存。`);
    error.code = "INVALID_INPUT";
    error.statusCode = 400;
    return error;
  };
  const endField = () => {
    if (state === "quoted") throw invalid();
    row.push(state === "afterQuote" ? field : field.trim());
    if (row.length > maxFields) throw invalid();
    field = ""; state = "start";
  };
  const endRow = () => {
    endField();
    if (present) rows.push(row);
    row = []; present = false;
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (state === "quoted") {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') { field += '"'; i++; }
      else state = "afterQuote";
      continue;
    }
    if (char === "|") { present = true; endField(); continue; }
    if (char === "\n" || char === "\r") {
      endRow();
      if (char === "\r" && input[i + 1] === "\n") i++;
      continue;
    }
    if (state === "afterQuote") {
      if (!/[ \t]/.test(char)) throw invalid();
      continue;
    }
    if (state === "start" && /[ \t]/.test(char)) continue;
    present = true;
    if (state === "start" && char === '"') state = "quoted";
    else { state = "unquoted"; field += char; }
  }
  endRow();
  return rows;
}

module.exports = { formatFieldLines, parseFieldLines };
