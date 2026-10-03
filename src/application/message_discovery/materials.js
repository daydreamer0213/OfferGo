const { listCandidateEvidence } = require('../../storage/candidate_evidence_store');
const { listCandidateAnswerMemories, listCandidateFactRevisions } = require('../../storage/message_learning_store');

function candidateReplyMaterial(db, profileId) {
  return {
    candidateEvidence: listCandidateEvidence(db, { profileId }),
    factRevisions: listCandidateFactRevisions(db, { profileId, limit: 2000 }),
    answerMemories: listCandidateAnswerMemories(db, { profileId, activeOnly: true, source: 'user_edited_reply', limit: 500 })
  };
}

module.exports = { candidateReplyMaterial };
