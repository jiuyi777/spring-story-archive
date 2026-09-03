export const PREFERENCE_QUIZ_SOURCE = Object.freeze({
  name: 'International Personality Item Pool (IPIP)',
  frameworkUrl: 'https://ipip.ori.org/newBigFive5broadKey.htm',
  permissionUrl: 'https://ipip.ori.org/newPermission.htm',
  note: '参照 IPIP 大五维度改写为角色扮演情境题；用于剧情适配，不作心理诊断。',
});

export const PREFERENCE_QUIZ_SCALE = Object.freeze([
  { value: 1, label: '非常不同意' },
  { value: 2, label: '比较不同意' },
  { value: 3, label: '中立或不知道' },
  { value: 4, label: '比较同意' },
  { value: 5, label: '非常同意' },
]);

export const PREFERENCE_QUIZ_ITEMS = Object.freeze([
  { id: 'interaction_active', trait: 'interaction', reverse: false, text: '我喜欢 NPC 主动和我建立联系，让场景里持续有人际互动。' },
  { id: 'interaction_observe', trait: 'interaction', reverse: true, text: '我更喜欢安静观察环境，不希望角色频繁把注意力集中到我身上。' },
  { id: 'relationship_empathy', trait: 'relationship', reverse: false, text: '我会在意角色为什么这样做，也愿意理解他们的感受和立场。' },
  { id: 'relationship_distance', trait: 'relationship', reverse: true, text: '只要事件能继续，人物之间的误会和情感变化并不重要。' },
  { id: 'structure_continuity', trait: 'structure', reverse: false, text: '我希望时间、地点、线索和人物关系都能严密衔接。' },
  { id: 'structure_improvise', trait: 'structure', reverse: true, text: '比起严谨连续，我更享受随时出现的即兴转折。' },
  { id: 'tension_pressure', trait: 'tension', reverse: false, text: '适度的危险、冲突和失败代价会让我更投入剧情。' },
  { id: 'tension_comfort', trait: 'tension', reverse: true, text: '我更想获得安全舒缓的体验，不希望剧情持续施压。' },
  { id: 'novelty_imagination', trait: 'novelty', reverse: false, text: '我喜欢陌生设定、复杂谜团和出乎意料但合理的新事物。' },
  { id: 'novelty_familiar', trait: 'novelty', reverse: true, text: '我更偏好熟悉稳定的发展，不需要频繁加入新设定或新人物。' },
]);

export const PREFERENCE_TRAIT_LABELS = Object.freeze({
  interaction: '互动主动度',
  relationship: '人物关系关注度',
  structure: '连续性与结构需求',
  tension: '冲突与压力接受度',
  novelty: '新奇与想象偏好',
});

export const STORY_EXPERIENCE_OPTIONS = Object.freeze([
  { id: 'relationship', label: '人物关系', description: '慢慢建立信任、亲密、依赖或对立' },
  { id: 'mystery', label: '调查解谜', description: '追踪线索、验证推理、揭开秘密' },
  { id: 'exploration', label: '世界探索', description: '进入陌生地点、接触文化与规则' },
  { id: 'strategy', label: '权谋博弈', description: '立场、资源、谈判与长期布局' },
  { id: 'action', label: '行动冒险', description: '危机、追逐、战斗与即时选择' },
  { id: 'daily', label: '日常生活', description: '细腻生活、陪伴与稳定节奏' },
  { id: 'growth', label: '成长建设', description: '能力、事业、家园或组织逐步发展' },
  { id: 'dilemma', label: '道德困境', description: '没有标准答案的选择与真实代价' },
  { id: 'suspense', label: '悬疑压迫', description: '未知威胁、心理压力与有限信息' },
  { id: 'romance', label: '情感恋爱', description: '双向吸引、磨合与关系变化' },
  { id: 'lore', label: '设定考据', description: '严密世界观、历史与因果链' },
  { id: 'surprise', label: '合理意外', description: '有铺垫、可回溯的新转折' },
]);

export function scorePreferenceQuiz(answers) {
  const buckets = new Map();
  for (const item of PREFERENCE_QUIZ_ITEMS) {
    const raw = Number(answers?.[item.id]);
    if (!Number.isFinite(raw) || raw < 1 || raw > 5) continue;
    const value = item.reverse ? 6 - raw : raw;
    const current = buckets.get(item.trait) ?? [];
    current.push(value);
    buckets.set(item.trait, current);
  }
  const scores = {};
  for (const [trait, values] of buckets) {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    scores[trait] = Math.round(((average - 1) / 4) * 100);
  }
  return scores;
}

export function isPreferenceQuizComplete(answers) {
  return PREFERENCE_QUIZ_ITEMS.every((item) => {
    const value = Number(answers?.[item.id]);
    return Number.isFinite(value) && value >= 1 && value <= 5;
  });
}
