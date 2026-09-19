const $ = id => document.getElementById(id);
let token = '';
let state;
let me;
let busy = false;
let refreshing = false;
let selection = null;
let ranking = [];
let rankingDirty = false;
let clockOffset = 0;
let receivedAt = 0;
try { token = sessionStorage.getItem('choice-token') || ''; } catch {}
let theme;
try { theme = localStorage.getItem('choice-theme'); } catch {}
if (!['light', 'dark'].includes(theme)) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
function setTheme(value) {
  document.documentElement.dataset.theme = value;
  $('theme').textContent = value === 'dark' ? '☀' : '☾';
  $('theme').title = $('theme').ariaLabel = value === 'dark' ? '切换到亮色模式' : '切换到暗色模式';
}
setTheme(theme);
$('theme').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  try { localStorage.setItem('choice-theme', theme); } catch {}
};
function message(text = '') { $('message').textContent = text; $('message').hidden = !text; }
function saveToken(value) {
  token = value;
  try { value ? sessionStorage.setItem('choice-token', value) : sessionStorage.removeItem('choice-token'); } catch {}
}
async function api(url, options = {}, credential = token) {
  const response = await fetch(url, { ...options, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...options.headers }, signal: AbortSignal.timeout(10000) });
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
function renderPublic() {
  $('project-title').textContent = state.title;
  document.title = state.title;
  renderCountdown();
  $('current').textContent = state.current ? `等待 ${state.current.name} 选择` : '全部选择已完成';
  $('progress-text').textContent = state.current ? `当前第 ${state.current.number} 位 · 共 ${state.total} 次选择` : '所有选择已保存';
  $('progress-count').textContent = `${state.completed.length} / ${state.total}`;
  $('progress').max = state.total;
  $('progress').value = state.completed.length;
  $('options').replaceChildren(...state.options.map(option => {
    const row = element('div', undefined, `option-row${option.remaining ? '' : ' full'}`);
    const line = element('div', undefined, 'option-line');
    const quantity = element('span', undefined, 'quantity');
    quantity.append(element('strong', option.remaining), document.createTextNode(` / ${option.capacity}`));
    line.append(element('span', option.name, 'option-name'), quantity);
    const bar = element('progress');
    bar.max = option.capacity;
    bar.value = option.remaining;
    bar.setAttribute('aria-label', `${option.name}剩余 ${option.remaining}，总量 ${option.capacity}`);
    row.append(line, bar);
    return row;
  }));
  $('history-count').textContent = `${state.completed.length} 人次`;
  $('empty').hidden = !!state.completed.length;
  $('history-table').hidden = !state.completed.length;
  $('history').replaceChildren(...state.completed.map(person => {
    const row = element('tr');
    row.append(element('td', String(person.number).padStart(2, '0')), element('td', person.name), element('td', person.option));
    return row;
  }));
}
function renderCountdown() {
  if (!state) return;
  const stale = Date.now() - receivedAt > 10000;
  $('countdown').textContent = !state.current ? '' : stale ? '倒计时等待同步' : state.deadline === null ? '不限时' : `本轮剩余 ${Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000))} 秒`;
}
function renderRanking() {
  const waiting = me && state && me.choice === null && state.current?.number !== me.number;
  $('preferences-form').hidden = !waiting;
  if (!waiting) return;
  if (!rankingDirty) ranking = [...(me.preferences ?? [])];
  const focusKey = document.activeElement?.dataset.rankKey;
  $('preferences-status').textContent = rankingDirty ? '未保存' : ranking.length ? '已保存 · 仅自己可见' : '未设置';
  $('ranking').replaceChildren(...ranking.map((id, index) => {
    const row = element('li', undefined, 'rank-row');
    const option = state.options.find(item => item.id === id);
    row.append(element('span', `${index + 1}. ${option.name}${option.remaining ? '' : '（已满）'}`, 'rank-name'));
    for (const [symbol, label, action, disabled] of [
      ['↑', '上移', () => { [ranking[index - 1], ranking[index]] = [ranking[index], ranking[index - 1]]; }, index === 0],
      ['↓', '下移', () => { [ranking[index + 1], ranking[index]] = [ranking[index], ranking[index + 1]]; }, index === ranking.length - 1],
      ['×', '移除', () => ranking.splice(index, 1), false]
    ]) {
      const button = element('button', symbol);
      button.type = 'button';
      button.title = button.ariaLabel = `${label} ${option.name}`;
      button.dataset.rankKey = `${id}-${label}`;
      button.disabled = busy || disabled;
      button.onclick = () => { action(); rankingDirty = true; renderRanking(); };
      row.append(button);
    }
    return row;
  }));
  const selected = $('preference-option').value;
  const candidates = state.options.filter(option => me.allowed.includes(option.id) && !ranking.includes(option.id));
  $('preference-option').replaceChildren(...candidates.map(option => {
    const node = element('option', option.name + (option.remaining ? '' : '（已满）'));
    node.value = option.id;
    return node;
  }));
  if (candidates.some(option => String(option.id) === selected)) $('preference-option').value = selected;
  $('preference-option').disabled = busy || !candidates.length;
  $('add-preference').disabled = busy || !candidates.length;
  $('save-preferences').disabled = busy || !rankingDirty;
  if (focusKey) [...$('ranking').querySelectorAll('button')].find(button => button.dataset.rankKey === focusKey)?.focus();
}
function renderPersonal() {
  $('login-form').hidden = !!me;
  $('identity').hidden = !me;
  $('logout').hidden = !me;
  $('logout').disabled = busy;
  renderRanking();
  if (!me || !state) return;
  $('my-name').textContent = me.name;
  $('my-number').textContent = `第 ${me.number} 位`;
  const done = me.choice !== null;
  const turn = state.current?.number === me.number;
  const available = state.options.filter(option => me.allowed.includes(option.id));
  const blocked = !available.some(option => option.remaining > 0);
  $('my-status').textContent = done ? `已选择：${state.options.find(option => option.id === me.choice)?.name}` : blocked ? '允许的项目均已满，请联系组织者。' : turn ? '轮到你了，请选择一个项目。' : `等待第 ${state.current?.number} 位完成，尚未轮到你。`;
  $('choice-form').hidden = done;
  if (done) return;
  if (!available.some(option => option.id === selection && option.remaining)) selection = null;
  const focusedChoice = document.activeElement?.name === 'option' ? document.activeElement.value : null;
  const legend = element('legend', '允许选择的项目', 'sr-only');
  $('choices').replaceChildren(legend, ...available.map(option => {
    const label = element('label', undefined, `choice-row${option.remaining ? '' : ' unavailable'}`);
    if (option.remaining) {
      const input = element('input');
      input.type = 'radio';
      input.name = 'option';
      input.value = option.id;
      input.checked = selection === option.id;
      input.disabled = !turn || busy;
      input.onchange = () => { selection = option.id; $('submit-choice').disabled = !turn || busy; };
      label.append(input);
    } else label.append(element('span', '—', 'choice-marker'));
    label.append(element('span', option.name), element('small', option.remaining ? `余 ${option.remaining}` : '已满'));
    return label;
  }));
  if (focusedChoice) document.querySelector(`input[name="option"][value="${focusedChoice}"]`)?.focus();
  $('submit-choice').disabled = !turn || blocked || !selection || busy;
  $('submit-choice').textContent = busy ? '正在保存…' : '确认选择';
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const credential = token;
  try {
    const nextMe = credential ? await api('/api/me', {}, credential) : null;
    const nextState = await api('/api/state', {}, '');
    if (credential !== token) return;
    state = nextState;
    me = nextMe;
    // Public results can advance between the two reads.
    const completed = me && state.completed.find(person => person.number === me.number);
    if (completed) me.choice = state.options.find(option => option.name === completed.option).id;
    receivedAt = Date.now();
    clockOffset = state.serverNow - receivedAt;
    $('connection').hidden = true;
    renderPublic();
    renderPersonal();
  } catch (error) {
    if (credential !== token) return;
    if (error.status === 401) { saveToken(''); me = null; renderPersonal(); message(error.message); }
    else { $('connection').textContent = '连接暂时中断，正在重试。当前显示可能不是最新状态。'; $('connection').hidden = false; $('submit-choice').disabled = true; }
  } finally { refreshing = false; }
}
$('login-form').onsubmit = async event => {
  event.preventDefault();
  const candidate = $('token').value.trim();
  $('login-button').disabled = true;
  message();
  try {
    const identity = await api('/api/me', {}, candidate);
    saveToken(candidate);
    me = identity;
    selection = null;
    rankingDirty = false;
    $('token').value = '';
    renderPersonal();
    await refresh();
  } catch (error) { message(error.status ? error.message : '无法连接服务，请重试。'); }
  finally { $('login-button').disabled = false; }
};
$('logout').onclick = () => { saveToken(''); me = null; selection = null; rankingDirty = false; ranking = []; message(); renderPersonal(); };
$('add-preference').onclick = () => {
  const id = Number($('preference-option').value);
  if (!id || busy || ranking.includes(id)) return;
  ranking.push(id);
  rankingDirty = true;
  renderRanking();
};
$('preferences-form').onsubmit = async event => {
  event.preventDefault();
  if (busy || !rankingDirty) return;
  busy = true;
  const submitted = [...ranking];
  message();
  renderPersonal();
  try {
    await api('/api/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: submitted }) });
    me.preferences = submitted;
    rankingDirty = false;
    message(submitted.length ? '预选择已保存。' : '预选择已清除。');
  } catch (error) { message(error.status ? error.message : '保存结果未确认，请重试。'); }
  finally { busy = false; await refresh(); renderPersonal(); }
};
$('choice-form').onsubmit = async event => {
  event.preventDefault();
  if (busy || !selection || !me || state.current?.number !== me.number) return;
  const option = state.options.find(item => item.id === selection);
  if (!window.confirm(`确定选择“${option.name}”吗？\n确认后此 Token 将被使用，无法更改。`)) return;
  busy = true;
  message();
  renderPersonal();
  try {
    await api('/api/choose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionId: selection }) });
    message('选择已保存。');
  } catch (error) { message(error.status ? error.message : '未能确认提交结果，请等待刷新后再检查。'); }
  finally { busy = false; await refresh(); renderPersonal(); }
};
void refresh();
setInterval(() => { if (!busy && !document.hidden) void refresh(); }, 2500);
setInterval(renderCountdown, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
