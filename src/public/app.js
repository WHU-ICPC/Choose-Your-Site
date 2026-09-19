import { selectionPreview } from './selection.js';

const byId = id => document.getElementById(id);
let token = '';
let state;
let me;
let ranking = [];
let rankingDirty = false;
let selectedNumber = null;
const drafts = new Map();
let settingsDirty = false;
let busy = false;
let refreshing = false;
let revision = 0;
let receivedAt = 0;
let clockOffset = 0;
try { token = sessionStorage.getItem('choice-token') || ''; } catch {}
let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
try { theme = localStorage.getItem('choice-theme') || theme; } catch {}
byId('theme').value = theme === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = byId('theme').value;
byId('theme').onchange = () => {
  document.documentElement.dataset.theme = byId('theme').value;
  try { localStorage.setItem('choice-theme', byId('theme').value); } catch {}
};
function message(text = '') {
  byId('message').textContent = text;
  byId('message').hidden = !text;
}
function saveToken(value) {
  token = value;
  try { value ? sessionStorage.setItem('choice-token', value) : sessionStorage.removeItem('choice-token'); } catch {}
}
async function api(route, body, credential = token) {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function localTime(timestamp) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function renderCountdown() {
  if (!state) return;
  const seconds = Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000));
  byId('countdown').textContent = !state.current || state.deadline === null ? '' : Date.now() - receivedAt > 10000 ? '等待同步锁定时间' : '距下一次锁定 ' + seconds + ' 秒';
}
function render() {
  if (!state) return;
  byId('project-title').textContent = document.title = state.title;
  byId('current').textContent = state.current ? '下一位：第 ' + state.current.number + ' 位 ' + state.current.name + ' · 已锁定 ' + state.completedCount + ' / ' + state.total : '全部锁定完成 · ' + state.total + ' 人次';
  byId('schedule').textContent = state.settings.startAt === null ? '开始时刻待设置' : '开始：' + new Date(state.settings.startAt).toLocaleString() + ' · 每隔 ' + state.settings.intervalSeconds + ' 秒锁定一位';
  renderCountdown();
  byId('options').replaceChildren(...state.options.map(option => {
    const card = element('div', undefined, 'option');
    card.append(element('div', option.name + '：'), element('div', '已锁定 ' + (option.capacity - option.remaining) + ' / ' + option.capacity));
    return card;
  }));
  byId('history').replaceChildren(...state.people.map(person => {
    const row = element('tr');
    row.append(element('td', person.number), element('td', person.name), element('td', person.group), element('td', person.option));
    return row;
  }));
  byId('login-form').hidden = !!me;
  byId('identity').hidden = !me;
  byId('logout').hidden = !me;
  byId('logout').disabled = busy;
  const participant = me?.role === 'participant';
  const position = participant ? me.positions.find(person => person.number === selectedNumber) ?? me.positions.find(person => person.lockedAt === null) ?? me.positions[0] : null;
  byId('position-picker').hidden = !position;
  if (position) {
    selectedNumber = position.number;
    const groupCounts = new Map();
    byId('position').replaceChildren(...me.positions.map(person => {
      const ordinal = (groupCounts.get(person.group) ?? 0) + 1;
      groupCounts.set(person.group, ordinal);
      const option = element('option', person.group + ' 第' + ordinal + '个' + (person.lockedAt === null ? '' : ' · 已锁定'));
      option.value = person.number;
      return option;
    }));
    byId('position').value = selectedNumber;
    byId('position').disabled = busy;
  }
  const result = position && state.people.find(person => person.number === position.number);
  const completed = result?.lockedAt !== null && result;
  const editable = position && position.lockedAt === null && !completed;
  byId('preferences-form').hidden = !editable;
  byId('settings-form').hidden = me?.role !== 'admin';
  if (me) {
    byId('my-name').textContent = me.name;
    const deadline = position && state.settings.startAt !== null ? state.settings.startAt + (position.number - 1) * state.settings.intervalSeconds * 1000 : null;
    byId('my-status').textContent = !position ? '管理活动开始时刻和锁定间隔' : position.lockedAt !== null ? '已锁定：' + (state.options.find(option => option.id === position.choice)?.name ?? '无可用选项') : completed ? '已锁定，等待结果同步' : deadline === null ? '确认倾向排列，等待活动开始' : '锁定时刻：' + new Date(deadline).toLocaleString();
  }
  if (editable) {
    if (!rankingDirty) ranking = [...position.preferences];
    const preview = selectionPreview(state.options, state.people, { ...position, name: me.name }, ranking);
    byId('selection-preview').textContent = preview.choice === null ? '当前无可用选项' : '预计选择：' + state.options.find(option => option.id === preview.choice).name;
    const focusKey = document.activeElement?.dataset.rankKey;
    byId('ranking').replaceChildren(...ranking.map((id, index) => {
      const option = state.options.find(item => item.id === id);
      const excluded = preview.excluded.has(id);
      const selected = preview.choice === id;
      const row = element('li', undefined, 'rank-row' + (excluded ? ' rank-excluded' : selected ? ' rank-selected' : ''));
      const label = excluded ? ' · 本人同组前面已选' : selected ? ' · 预计选中' : '';
      row.append(element('span', (index + 1) + '. ' + option.name + '（余 ' + preview.remaining.get(id) + '）' + label, 'rank-name'));
      for (const [offset, symbol, label] of [[-1, '↑', '上移'], [1, '↓', '下移']]) {
        const button = element('button', symbol);
        button.type = 'button';
        button.ariaLabel = label + ' ' + option.name;
        button.dataset.rankKey = id + '-' + offset;
        button.disabled = busy || index + offset < 0 || index + offset >= ranking.length;
        button.onclick = () => {
          [ranking[index], ranking[index + offset]] = [ranking[index + offset], ranking[index]];
          rankingDirty = true;
          render();
        };
        row.append(button);
      }
      return row;
    }));
    byId('save-preferences').disabled = busy || (!rankingDirty && position.confirmedAt != null);
    byId('preferences-status').textContent = rankingDirty || position.confirmedAt == null ? '未确认' : '已确认';
    if (focusKey) [...byId('ranking').querySelectorAll('button')].find(button => button.dataset.rankKey === focusKey)?.focus();
  }
  if (me?.role === 'admin') {
    if (!settingsDirty) {
      byId('start-at').value = state.settings.startAt === null ? '' : localTime(state.settings.startAt);
      byId('interval').value = state.settings.intervalSeconds ?? '';
    }
    const started = state.settings.startAt !== null && state.serverNow >= state.settings.startAt;
    for (const id of ['start-at', 'interval', 'save-settings']) byId(id).disabled = busy || started;
    byId('settings-status').textContent = started ? '活动已开始，设置已锁定' : settingsDirty ? '未保存' : state.settings.startAt === null ? '待设置' : '已保存';
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const credential = token;
  const requestRevision = revision;
  try {
    const nextState = await api('/api/state', undefined, '');
    const nextMe = credential ? await api('/api/me', undefined, credential) : null;
    if (credential !== token || requestRevision !== revision) return;
    me = nextMe;
    state = nextState;
    receivedAt = Date.now();
    clockOffset = state.serverNow - receivedAt;
    byId('connection').hidden = true;
    render();
  } catch (error) {
    if (credential !== token || requestRevision !== revision) return;
    if (error.status === 401) {
      saveToken('');
      me = null;
      selectedNumber = null;
      drafts.clear();
      rankingDirty = settingsDirty = false;
      render();
    }
    byId('connection').textContent = '同步失败：' + error.message;
    byId('connection').hidden = false;
  } finally { refreshing = false; }
}
byId('login-form').onsubmit = async event => {
  event.preventDefault();
  const candidate = byId('token').value.trim();
  byId('login-button').disabled = true;
  try {
    me = await api('/api/me', undefined, candidate);
    revision++;
    saveToken(candidate);
    selectedNumber = null;
    drafts.clear();
    rankingDirty = settingsDirty = false;
    byId('token').value = '';
    message();
    render();
    await refresh();
  } catch (error) { message(error.message); }
  finally { byId('login-button').disabled = false; }
};
byId('logout').onclick = () => {
  revision++;
  saveToken('');
  me = null;
  selectedNumber = null;
  drafts.clear();
  ranking = [];
  rankingDirty = settingsDirty = false;
  message();
  render();
  void refresh();
};
async function save(route, body, onSaved) {
  if (busy) return;
  revision++;
  busy = true;
  render();
  try {
    const result = await api(route, body);
    onSaved(result);
    message(route === '/api/preferences' ? '排列已确认。' : '已保存。');
  } catch (error) { message(error.message); }
  finally { busy = false; await refresh(); render(); }
}
byId('position').onchange = () => {
  if (rankingDirty) drafts.set(selectedNumber, [...ranking]);
  selectedNumber = Number(byId('position').value);
  rankingDirty = drafts.has(selectedNumber);
  ranking = [...(drafts.get(selectedNumber) ?? [])];
  message();
  render();
};
byId('preferences-form').onsubmit = event => {
  event.preventDefault();
  const preferences = [...ranking];
  const number = selectedNumber;
  void save('/api/preferences', { number, preferences }, result => {
    Object.assign(me.positions.find(person => person.number === number), { preferences, confirmedChoice: result.confirmedChoice, confirmedAt: result.confirmedAt });
    drafts.delete(number);
    rankingDirty = false;
  });
};
byId('settings-form').oninput = () => { settingsDirty = true; byId('settings-status').textContent = '未保存'; };
byId('settings-form').onsubmit = event => {
  event.preventDefault();
  const startAt = byId('start-at').value ? new Date(byId('start-at').value).getTime() : null;
  const intervalSeconds = Number(byId('interval').value);
  void save('/api/settings', { startAt, intervalSeconds }, () => { state.settings = { startAt, intervalSeconds }; settingsDirty = false; });
};
void refresh();
setInterval(() => { if (!busy && !document.hidden) void refresh(); }, 2500);
setInterval(renderCountdown, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) void refresh(); });
