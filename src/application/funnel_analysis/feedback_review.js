const { incomingContactKey } = require('./incoming_contacts');

const TOPICS = {
  responsibility: { title: '先核对项目中的本人职责', action: '对照这条问题和已发送的回答，讲清本人负责哪一部分、做过哪些具体工作、交付了什么。需要调整简历时，先改对应的项目经历。' },
  method: { title: '先把项目做法和选择原因讲具体', action: '围绕对方问到的做法，说明为什么这样选、怎样实施、如何判断结果。先检查已有回答，再补对应项目的说明。' },
  result: { title: '先说明项目实际取得的结果', action: '用已有的交付、验证过程和实际效果回答这条问题；定性结果也可以。需要调整简历时，先改这个项目的成果描述。' },
  project_fact: { title: '先核对这条项目问题的回答', action: '对照 HR 的具体问题、原项目描述和已发送回答，补清对方关心的个人工作、方法或结果。先处理这段经历，再观察后续沟通。' },
  salary: { title: '先核对这份岗位的薪资沟通', action: '先核对并回答实际期望薪资，再与这份岗位的范围比较。对方询问薪资本身不代表条件冲突；已有明确差距时，再决定这份机会是否继续。' },
  availability: { title: '先核对时间和到岗安排', action: '按原话区分面试时间、到岗日期和当前在职状态，用已确认的信息回应；有时间冲突时，先协调具体安排。' },
  qualification: { title: '先回应对方询问的具体条件', action: '按简历和已确认的信息回答这条条件问题。只有明确不兼容时才调整这份机会；正常履历核验本身不说明岗位不合适。' },
  salary_ended: { title: '先复盘这份机会提到的薪资条件', action: '这份机会的结束沟通涉及薪资。对照原话、岗位范围和实际期望，决定后续同类岗位的选择或沟通方式。' },
  availability_ended: { title: '先复盘这份机会提到的时间条件', action: '这份机会已结束，先核对原话中的面试、到岗或时间条件；把确实存在的限制用于后续安排。' },
  qualification_ended: { title: '先核对这份机会结束时提到的条件', action: '按 HR 原话核对具体条件和已有事实，再决定后续同类岗位的应聘方式。一份岗位的反馈只支持检查这项条件。' },
  rejection: { title: '先核对结束沟通的具体说明', action: '阅读下面的原话：对方说明了具体条件或能力问题时，针对该项检查；只表示不合适时，原因仍不明确，先保留记录。' }
};

function messageTime(message) {
  return Date.parse(message.occurredAt || message.firstObservedAt || '') || 0;
}

function buildFeedbackReview({ profileId, samples = [] } = {}) {
  const groups = new Map();
  const seen = new Set();
  const add = (sample, category, message = null, priority = 1) => {
    const key = `${sample.site}:${category}`;
    const identity = `${sample.site}:${sample.conversationKey || 'card:' + sample.cardId}:${message?.messageKey || category}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const special = {
      offer: { title: '先核对 Offer 条件和下一步安排', action: '已记录收到 Offer，优先核对书面条件、薪资、入职时间和待回复事项，再决定后续安排。', target: 'interview' },
      interview: { title: '先补齐面试后的反馈与进展', action: '核对这次面试的反馈和下一步安排。还在等待时先保留等待状态；有具体追问或反馈时，再针对那部分准备。', target: 'interview' },
      resume: { title: '先查看发送简历后的反馈', action: '已记录发送简历动作成功。先查看对方的反馈和后续进展，再决定是否调整项目或技能描述。', target: 'messages' }
    }[category];
    const wording = special || TOPICS[category];
    if (!groups.has(key)) groups.set(key, { key, site: sample.site, category, title: wording.title, action: wording.action,
      target: wording.target || 'messages', priority, evidence: [], jobIds: new Set() });
    const topic = groups.get(key);
    topic.priority = Math.min(topic.priority, priority);
    topic.jobIds.add(sample.jobId);
    const ordered = [...(sample.messages || [])].sort((a, b) => messageTime(a) - messageTime(b) || a.id - b.id);
    const position = message ? ordered.findIndex(item => item.messageKey === message.messageKey) : -1;
    const following = position < 0 ? [] : ordered.slice(position + 1);
    const nextHr = following.findIndex(item => item.direction === 'friend');
    const replies = (nextHr < 0 ? following : following.slice(0, nextHr))
      .filter(item => item.direction === 'myself' && item.kind === 'text');
    topic.evidence.push({ jobId: sample.jobId, cardId: sample.cardId, title: sample.title, company: sample.company,
      quote: message?.text || '', replyText: replies.map(item => item.text).join('\n'),
      description: sample.description || '', resumeText: sample.resumeText || '', resumeVersionId: sample.resumeVersionId,
      conversationKey: sample.conversationKey, contactKey: sample.conversationKey ? incomingContactKey(profileId, sample.site, sample.conversationKey) : '',
      messageKey: message?.messageKey || '', occurredAt: message?.occurredAt || message?.firstObservedAt || sample.resumeSentAt || '',
      cardStage: sample.cardStage, resumeSentAt: sample.resumeSentAt || null });
  };
  for (const sample of samples) {
    if (sample.cardStage === 'offer_received') { add(sample, 'offer', null, 0); continue; }
    const classifications = new Map((sample.classifications || []).map(item => [item.messageKey, item]));
    let cited = false;
    for (const message of sample.messages || []) {
      if (message.direction !== 'friend' || message.kind !== 'text' || !message.text) continue;
      const classification = classifications.get(message.messageKey);
      if (!classification) continue;
      const rejected = classification.messageIntent === 'rejection' || classification.type === 'recruiter_rejected';
      if (!rejected && (classification.messageIntent !== 'information_request' || ['rejected', 'withdrawn', 'closed'].includes(sample.cardStage))) continue;
      let category = classification.messageCategory;
      if (rejected) category = ['salary', 'availability', 'qualification'].includes(category) ? category + '_ended' : 'rejection';
      // These are question topics, never evidence of a defect or a rejection cause.
      if (category === 'project_fact') {
        if (/负责|职责|分工|个人贡献|你做|本人/.test(message.text)) category = 'responsibility';
        else if (/为什么|如何|怎么|方案|选择|取舍|验证|测试/.test(message.text)) category = 'method';
        else if (/结果|效果|指标|提升|成果/.test(message.text)) category = 'result';
      }
      if (!TOPICS[category]) continue;
      add(sample, category, message, sample.cardStage === 'interview_completed' ? 3 : rejected ? 3 : 1); cited = true;
    }
    if (sample.cardStage === 'interview_completed') add(sample, 'interview', null, 2);
    else if (!cited && sample.resumeSentAt && !['rejected', 'withdrawn', 'closed', 'interview_invited', 'interview_scheduled'].includes(sample.cardStage)) add(sample, 'resume', null, 4);
  }
  const topics = [...groups.values()].map(({ jobIds, ...topic }) => ({ ...topic, jobCount: jobIds.size,
    detail: topic.evidence.some(item => item.quote)
      ? `${jobIds.size} 个岗位的已保存 HR 消息涉及这一主题。这是具体检查线索，不代表已确认简历或能力有问题。`
      : `${jobIds.size} 个岗位有这项已记录进展，可先核对后续安排。`,
    nextCheck: '先处理这一项，保留其他版本与条件；之后观察同类岗位的回复、约面和后续进展。'
  })).sort((a, b) => a.priority - b.priority || b.jobCount - a.jobCount || a.key.localeCompare(b.key));
  return { primary: topics[0] || null, topics };
}

module.exports = { buildFeedbackReview };
