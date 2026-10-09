const SOFT_QUALIFIER = /优先|加分|可接受|接受|欢迎|亦可|均可|不限|无硬性要求/;
const EXCLUSIVE_QUALIFIER = /仅限|只招|仅招|限定|仅面向|只接受|仅接受|必须|须为|需为|要求为/;

function evaluateJobEligibility(job = {}, {
  candidateProfile = {},
  targetJobTypes = ["全职"],
  allowPartTime = false
} = {}) {
  const jobEvidence = [];
  const candidateEvidence = [];
  const qualityTags = [];
  const risks = [];
  const targetAcceptsInternship = targetJobTypes.some((item) => /实习|intern/i.test(String(item || "")));
  const employment = employmentTypeOf(job);
  jobEvidence.push(...employment.evidence);

  let reasonCode = "";
  let status = "eligible";
  if ((employment.type === "part_time" || employment.partTime) && allowPartTime !== true) {
    status = "blocked";
    reasonCode = "part_time_role";
    qualityTags.push(reasonCode);
    risks.push("岗位为兼职或按小时计薪，当前未选择接受兼职");
  }
  if (employment.type === "internship" && !targetAcceptsInternship) {
    status = "blocked";
    reasonCode = "internship_role";
    qualityTags.push(reasonCode);
    risks.push("岗位明确为实习性质，不符合当前全职目标");
  }

  const candidate = candidateEducationFacts(candidateProfile);
  const cohort = requiredCohortConstraint(job.description);
  if (cohort) {
    const overlappingDates = cohort.dateWindow
      ? candidate.graduationWindows.filter(window => window.maximum >= cohort.dateWindow.minimum
        && window.minimum <= cohort.dateWindow.maximum)
      : [];
    const dateConfirmed = overlappingDates.some(window => window.minimum >= cohort.dateWindow.minimum
      && window.maximum <= cohort.dateWindow.maximum);
    const knownMatch = cohort.dateWindow ? dateConfirmed
      : candidate.graduationYears.some(year => matchesCohort(cohort, year));
    jobEvidence.push(cohort.evidence);
    if ((!knownMatch && candidate.unresolvedGraduation) || !candidate.graduationYears.length || (cohort.dateWindow
      && (!candidate.graduationWindows.length || (overlappingDates.length && !dateConfirmed)))) {
      if (status !== "blocked") {
        status = "review";
        reasonCode = "eligibility_review";
        qualityTags.push("eligibility_review");
        risks.push("岗位有明确届别要求，候选人毕业年份待确认");
      }
    } else if (cohort.dateWindow ? !overlappingDates.length : !candidate.graduationYears.some((year) => matchesCohort(cohort, year))) {
      status = "blocked";
      if (!reasonCode) reasonCode = "cohort_mismatch";
      qualityTags.push("cohort_mismatch");
      risks.push(`岗位要求 ${cohortLabel(cohort)}，候选人毕业年份不符合`);
      candidateEvidence.push(`毕业年份：${candidate.graduationYears.join("、")}`);
    } else {
      candidateEvidence.push(`毕业年份：${candidate.graduationYears.join("、")}`);
    }
  }

  const studentClause = requiredStudentClause(job.description);
  if (studentClause) {
    jobEvidence.push(studentClause);
    if (candidate.inSchool) {
      candidateEvidence.push("教育状态：在读/在校");
    } else if (candidate.graduated) {
      status = "blocked";
      if (!reasonCode) reasonCode = "student_status_mismatch";
      qualityTags.push("student_status_mismatch");
      risks.push("岗位仅面向在校生，候选人材料显示已毕业");
      candidateEvidence.push("教育状态：已毕业");
    } else if (status !== "blocked") {
      status = "review";
      reasonCode = "eligibility_review";
      qualityTags.push("eligibility_review");
      risks.push("岗位仅面向在校生，候选人在校状态待确认");
    }
  }

  return {
    status,
    employmentType: employment.type,
    reasonCode,
    qualityTags: unique(qualityTags),
    risks: unique(risks),
    evidence: {
      job: evidenceSnippets(jobEvidence),
      candidate: evidenceSnippets(candidateEvidence)
    }
  };
}

function employmentTypeOf(job) {
  const title = normalized(job.title);
  const structured = normalized([
    job.jobType,
    job.employmentType,
    job.workType,
    ...(Array.isArray(job.tags) ? job.tags : [])
  ].filter(Boolean).join(" "));
  const description = normalized(job.description);
  const combined = `${title} ${structured} ${description}`;
  const partTime = partTimeEmployment(title, structured, description, job.salary);
  const mixed = combined.match(/(?:全职|社招).{0,10}(?:或|\/|、|均可|皆可).{0,10}实习(?:生)?|实习(?:生)?.{0,10}(?:或|\/|、|均可|皆可).{0,10}(?:全职|社招)|(?:可接受|欢迎)实习生/);
  if (mixed) return partTime || { type: "mixed", evidence: [mixed[0]] };

  const metadata = `${title} ${structured}`;
  const metadataInternship = /实习经验|实习经历/.test(metadata)
    ? null
    : metadata.match(/实习生?|intern(?:ship)?/i);
  const descriptionInternship = internshipDescriptionEvidence(description);
  const internship = metadataInternship?.[0]?.trim() || descriptionInternship;
  if (internship) return { type: "internship", partTime: partTime?.type === "part_time", evidence: [internship, ...(partTime?.evidence || [])] };
  if (partTime) return partTime;

  const fullTime = combined.match(/全职(?:岗位|职位)?|社会招聘|社招岗位/);
  return fullTime
    ? { type: "full_time", evidence: [fullTime[0]] }
    : { type: "unknown", evidence: [] };
}

function partTimeEmployment(title, structured, description, salary) {
  const clauses = [title, structured, ...semanticClauses(description)].map((clause) => clause
    .replace(/(?:不(?:是|接受|考虑|招(?:聘)?|需要|支持)|拒绝|谢绝|非)\s*兼职/g, "")
    .replace(/(?:非|不(?:接受|考虑|招(?:聘)?))\s*全职/g, "")
    .replace(/(?:负责|协助|岗位职责[:：]?)\s*(?:招聘|管理|培训|协调)(?:和管理)?\s*兼职(?:人员|员工|团队|老师)/g, "")
    .replace(/兼职(?:人员|员工|团队|老师)(?:招聘|管理|培训|协调)/g, "")
    .replace(/兼职.{0,8}(?:经验|经历)/g, ""));
  const mixed = clauses.find(clause => /全职\s*(?:[\/、或和]|与)\s*兼职|兼职\s*(?:[\/、或和]|与)\s*全职|(?:全职兼职|兼职全职)\s*(?:均可|皆可|不限)/.test(clause));
  if (mixed) return { type: "mixed", evidence: [mixed] };
  const metadata = `${clauses[0]} ${clauses[1]}`;
  const explicit = metadata.match(/兼职|part[ _-]?time/i)?.[0]
    || clauses.slice(2).find(clause => /(?:岗位|职位|工作性质|合作形式|工作周期).{0,12}兼职|(?:长期|短期|线上|线下|周末|远程)兼职|兼职(?:岗位|职位)|^(?:招聘|招募|只招|仅招)兼职/.test(clause));
  if (explicit) return { type: "part_time", evidence: [explicit] };
  const fullTime = /全职|full[ _-]?time/i.test(metadata)
    || clauses.slice(2).some(clause => /(?:岗位|职位|工作性质).{0,8}全职|全职(?:岗位|职位)|仅招全职/.test(clause));
  const hourlySalary = normalized(salary).match(/^\d+(?:\.\d+)?(?:\s*[-~—–至]\s*\d+(?:\.\d+)?)?\s*元\s*\/\s*(?:小时|时|h)$/i);
  if (hourlySalary && !fullTime) return { type: "part_time", evidence: [`岗位薪资：${hourlySalary[0]}`] };
  return null;
}

function internshipDescriptionEvidence(description) {
  for (const clause of semanticClauses(description)) {
    if (/实习经验|实习经历/.test(clause)
      && !/实习(?:周期|时长)|实习生(?:岗位|职位)|(?:岗位|职位).{0,12}实习生/.test(clause)) {
      continue;
    }
    const match = clause.match(/实习(?:周期|时长).{0,32}(?:月|周|天)|实习生(?:岗位|职位)|(?:岗位|职位|招聘|招募|面向).{0,12}实习生|实习生.{0,12}(?:招聘|招募)/);
    if (match) return clause;
  }
  return "";
}

function requiredCohortConstraint(description) {
  for (const clause of semanticClauses(description)) {
    if (!/届|毕业(?:时间|日期)/.test(clause) || isSoftQualification(clause)) continue;
    if (/毕业(?:时间|日期).{0,8}(?:不要求|不限制|无要求|没有限制)|不(?:要求|限制|限定).{0,8}毕业(?:时间|日期)/.test(clause)) continue;
    const dateRange = clause.match(/毕业(?:时间|日期).{0,12}?((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)\s*(?:[-—–~～]|至|到)\s*((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)/);
    if (dateRange) {
      const from = graduationDateWindow(dateRange[1]);
      const to = graduationDateWindow(dateRange[2]);
      if (from && to && from.minimum <= to.maximum && to.year - from.year <= 10) {
        return { dateWindow: { minimum: from.minimum, maximum: to.maximum },
          dateLabel: `${dateRange[1]} 至 ${dateRange[2]}毕业`, evidence: clause };
      }
    }
    const range = clause.match(/((?:20)?\d{2})\s*[-至到~～]\s*((?:20)?\d{2})\s*届/);
    if (range) {
      const minimum = normalizedYear(range[1]);
      const maximum = normalizedYear(range[2]);
      if (validYear(minimum) && validYear(maximum) && maximum >= minimum && maximum - minimum <= 10) {
        return { years: [], minimum, maximum, evidence: clause };
      }
    }
    const list = clause.match(/((?:(?:20)?\d{2}\s*(?:、|\/|或|,|，)\s*)+(?:20)?\d{2})\s*届/);
    if (list) {
      const years = yearsFrom(list[1]);
      if (years.length) return { years, minimum: 0, maximum: 0, evidence: clause };
    }
    const single = clause.match(/((?:20)?\d{2})\s*届/);
    if (single) {
      const year = normalizedYear(single[1]);
      if (validYear(year)) return { years: [year], minimum: 0, maximum: 0, evidence: clause };
    }
  }
  return null;
}

function requiredStudentClause(description) {
  return semanticClauses(description).find((clause) => {
    if (!/(?:在校生|在校学生|在读学生)/.test(clause)) return false;
    if (/不(?:要求|需要|限).{0,8}(?:在校|在读)|无需.{0,8}(?:在校|在读)|非在校/.test(clause)) return false;
    const requiresStudent = EXCLUSIVE_QUALIFIER.test(clause) || /面向.{0,8}(?:在校生|在校学生|在读学生)/.test(clause);
    return requiresStudent && !isSoftQualification(clause);
  }) || "";
}

function candidateEducationFacts(candidateProfile) {
  const education = Array.isArray(candidateProfile?.education) ? candidateProfile.education : [];
  const graduationYears = [];
  const graduationWindows = [];
  let graduated = false;
  let inSchool = false;
  let unresolvedGraduation = false;
  for (const item of education) {
    if (!item || typeof item !== "object") continue;
    const end = normalized(item.endDate || item.end || item.graduationYear);
    const year = Number(end.match(/(?:19|20)\d{2}/)?.[0] || 0);
    if (validYear(year)) graduationYears.push(year);
    const window = graduationDateWindow(end);
    if (window) graduationWindows.push(window);
    const status = normalized(item.status || item.graduationStatus);
    if (/已毕业|已经毕业|毕业完成|completed|graduated/i.test(status)) graduated = true;
    if (/在读|在校|就读中|预计毕业|studying|enrolled/i.test(status)) {
      inSchool = true;
      if (!window) unresolvedGraduation = true;
    }
  }
  return { graduationYears: unique(graduationYears).sort(), graduationWindows, graduated, inSchool, unresolvedGraduation };
}

function graduationDateWindow(value) {
  const match = normalized(value).match(/^((?:19|20)\d{2})(?:\s*(?:年|[-/.])\s*(\d{1,2})(?:\s*(?:月|[-/.])\s*(\d{1,2}))?)?/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] || 0);
  const day = Number(match[3] || 0);
  if (!validYear(year) || month > 12 || (match[2] && month < 1)) return null;
  const lastDay = month ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 31;
  if (day > lastDay || (match[3] && day < 1)) return null;
  return { year,
    minimum: year * 10000 + (month || 1) * 100 + (day || 1),
    maximum: year * 10000 + (month || 12) * 100 + (day || lastDay)
  };
}

function matchesCohort(constraint, year) {
  if (constraint.years.length) return constraint.years.includes(year);
  return year >= constraint.minimum && year <= constraint.maximum;
}

function cohortLabel(constraint) {
  if (constraint.dateWindow) return constraint.dateLabel;
  if (constraint.years.length) return `${constraint.years.join("/")} 届`;
  return `${constraint.minimum}-${constraint.maximum} 届`;
}

function semanticClauses(value) {
  return normalized(value)
    .split(/[。；;\n，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSoftQualification(value) {
  const clause = String(value || "");
  return SOFT_QUALIFIER.test(clause) && !EXCLUSIVE_QUALIFIER.test(clause);
}

function yearsFrom(value) {
  return unique([...String(value || "").matchAll(/(?:20)?\d{2}/g)]
    .map((match) => normalizedYear(match[0]))
    .filter(validYear)).sort();
}

function normalizedYear(value) {
  const text = String(value || "");
  return Number(text.length === 2 ? `20${text}` : text);
}

function validYear(value) {
  return Number.isInteger(value) && value >= 1990 && value <= 2100;
}

function evidenceSnippets(values) {
  return unique(values.map((item) => normalized(item).slice(0, 160)));
}

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = { evaluateJobEligibility, employmentTypeOf };
