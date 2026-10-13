export const API_PROFILES_KEY = 'spring-story-archive:extra-api-profiles:v1';
const LEGACY_KEY = 'spring-story-archive:extra-api-key';
const fields = ['name', 'endpoint', 'model', 'apiKey', 'embeddingModel'];

// Keep each connection and its key together; never include this store in archive exports.
export function openApiProfiles({ storage, session, legacy = {}, createId = () => crypto.randomUUID() }) {
  const blank = (name = '新配置') => ({ id: createId(), name, endpoint: '', model: '', apiKey: '', embeddingModel: '' });
  let state;
  const persist = (next) => {
    try { storage.setItem(API_PROFILES_KEY, JSON.stringify(next)); }
    catch { throw new Error('浏览器未能保存 API 配置，请检查网站存储权限或可用空间。'); }
    state = next;
  };
  let saved;
  try { saved = storage.getItem(API_PROFILES_KEY); }
  catch { throw new Error('浏览器无法读取已保存的 API 配置。'); }
  if (saved) {
    try {
      state = JSON.parse(saved);
      if (!Array.isArray(state.profiles) || !state.profiles.length
        || !state.profiles.every((profile) => typeof profile.id === 'string' && fields.every((key) => typeof profile[key] === 'string'))
        || !state.profiles.some((profile) => profile.id === state.activeId)) throw new Error();
    } catch { throw new Error('已保存的 API 配置无法读取，原数据已保留。'); }
  } else {
    let apiKey = '';
    try { apiKey = session?.getItem(LEGACY_KEY) ?? ''; } catch {}
    const profile = { ...blank('默认配置'), endpoint: legacy.extraEndpoint ?? '', model: legacy.extraModel ?? '',
      embeddingModel: legacy.recallEmbeddingModel ?? '', apiKey };
    persist({ activeId: profile.id, profiles: [profile] });
    // Remove the old key only after the persistent copy succeeds.
    try { session?.removeItem(LEGACY_KEY); } catch {}
  }
  const active = () => ({ ...state.profiles.find((profile) => profile.id === state.activeId) });
  const get = (id) => {
    const profile = state.profiles.find((item) => item.id === id);
    return profile ? { ...profile } : null;
  };
  return {
    active,
    get,
    list: () => state.profiles.map(({ id, name }) => ({ id, name })),
    update(changes) {
      const values = Object.fromEntries(fields.filter((key) => key in changes).map((key) => [key, String(changes[key])]));
      if ('name' in values) values.name = values.name.trim() || '未命名配置';
      persist({ ...state, profiles: state.profiles.map((profile) => profile.id === state.activeId ? { ...profile, ...values } : profile) });
    },
    select(id) {
      if (!state.profiles.some((profile) => profile.id === id)) throw new Error('这套 API 配置已不存在。');
      persist({ ...state, activeId: id });
    },
    add() {
      const profile = blank(`配置 ${state.profiles.length + 1}`);
      persist({ activeId: profile.id, profiles: [...state.profiles, profile] });
    },
    remove() {
      const profiles = state.profiles.filter((profile) => profile.id !== state.activeId);
      if (!profiles.length) profiles.push(blank('默认配置'));
      persist({ activeId: profiles[0].id, profiles });
    },
  };
}
