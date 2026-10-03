const { listCandidateEvidence } = require('../../storage/candidate_evidence_store');
const { listCandidateAnswerMemories, listCandidateFactRevisions } = require('../../storage/message_learning_store');
const { getActiveResumeText, getCandidateProfile } = require('../../storage/candidate_store');
const { prepareResumeTextForModel } = require('../../core/resume_privacy');

function candidateReplyMaterial(db, profileId) {
  const profile = getCandidateProfile(db, profileId);
  const text = getActiveResumeText(db, profileId);
  const names = [profile?.displayName, profile?.profile?.candidate?.name].filter(Boolean);
  return {
    currentResume: text ? { text: prepareResumeTextForModel(text, { identity: { names } }).text } : null,
    candidateEvidence: listCandidateEvidence(db, { profileId }),
    factRevisions: listCandidateFactRevisions(db, { profileId, limit: 2000 }),
    answerMemories: listCandidateAnswerMemories(db, { profileId, activeOnly: true, source: 'user_edited_reply', limit: 500 })
  };
}

module.exports = { candidateReplyMaterial };
