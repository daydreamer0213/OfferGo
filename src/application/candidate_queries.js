const { getCandidateProfile, getSearchPlan, getActiveSearchPlan, listSearchPlans } = require("../storage/candidate_store");

function getLatestSearchPlan(db, profileId) {
  return getActiveSearchPlan(db, profileId) || listSearchPlans(db, profileId)[0] || null;
}

module.exports = { getCandidateProfile, getSearchPlan, getLatestSearchPlan };
