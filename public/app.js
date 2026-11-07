const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const statusNames = { idle: '空闲', queued: '排队', running: '工作中', failed: '失败', completed: '已完成' };
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const cardWidth = 166;
const cardHeight = 82;

let companies = [];
let companyId = null;
let mode = null;
let source = null;
let snapshot = null;
let selectedBot = null;
let zoom = 1;
let fit = true;
let diagram = null;
let sending = false;
let nodeElements = new Map();
let edgeElements = new Map();

function el(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function badge(status, label = statusNames[status]) {
  const item = el('span', 'status-badge ' + status);
  item.append(el('i', 'dot ' + status), el('span', '', label));
  return item;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败。');
  return data;
}

function showError(message) {
  $('global-error').textContent = message;
  $('global-error').hidden = !message;
}

function connection(label, state = '') {
  $('connection').textContent = label;
  $('connection-dot').className = 'dot ' + state;
}

function renderCompanies() {
  $('company-count').textContent = companies.length;
  $('companies').replaceChildren(...companies.map((company, index) => {
    const button = el('button', 'company-item');
    button.type = 'button';
    if (company.id === companyId) button.setAttribute('aria-current', 'true');
    const mark = el('span', 'company-mark palette-' + (index % 3));
    mark.append(icon('build'));
    button.append(mark, el('span', 'company-name', company.name));
    button.addEventListener('click', () => openCompany(company.id));
    return button;
  }));
}

function openCompany(id) {
  if (id === companyId) return;
  source?.close();
  companyId = id;
  snapshot = null;
  diagram = null;
  selectedBot = null;
  fit = true;
  nodeElements.clear();
  edgeElements.clear();
  $('prompt').value = '';
  $('nodes').replaceChildren();
  $('edges').replaceChildren();
  $('viewport').scrollTo(0, 0);
  showError('');
  renderCompanies();
  const company = companies.find(item => item.id === id);
  $('company-title').textContent = company?.name ?? '公司总览';
  $('company-mission').textContent = company?.mission ?? '统一管理多家由 Bot 组成的公司。';
  $('crumb-company').textContent = company?.name ?? '公司总览';
  $('chief-scope').textContent = company ? '当前公司 · ' + company.name : '请选择一家公司';
  renderEmpty();
  if (!id) return;
  localStorage.setItem('bot-org-hq.current', id);
  connection('连接中');
  const stream = new EventSource('/api/companies/' + id + '/events');
  source = stream;
  stream.addEventListener('company', event => {
    if (source !== stream) return;
    snapshot = JSON.parse(event.data);
    connection('实时更新', 'running');
    render();
  });
  stream.onerror = () => {
    if (source === stream) connection('重新连接中', 'queued');
  };
}

function renderEmpty() {
  for (const id of ['staff-count', 'depth-count', 'active-count', 'queued-count']) $(id).textContent = '—';
  $('chart-empty').hidden = false;
  $('chart-empty').querySelector('p').textContent = companyId ? '正在加载组织架构…' : '新建一家公司，开始搭建团队。';
  $('chart-space').hidden = true;
  $('chief-status').hidden = true;
  $('run-demo').hidden = mode !== 'demo' || !companyId;
  $('messages').replaceChildren(el('p', 'placeholder', '在这里给 Chief 一个目标，它会安排当前公司的人员。'));
  $('activity').replaceChildren();
  $('inspector').replaceChildren(el('p', 'placeholder', '选择一名员工。'));
  updateControls();
}

function updateControls() {
  const disabled = !companyId || sending;
  $('send').disabled = disabled;
  $('run-demo').disabled = disabled;
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit']) $(id).disabled = !diagram;
}

function buildDiagram(bots) {
  const children = new Map(bots.map(bot => [bot.id, []]));
  const points = new Map();
  const root = bots.find(bot => bot.managerId === null);
  for (const bot of bots) if (bot.managerId) children.get(bot.managerId).push(bot);

  let leaves = 0;
  let depth = 0;
  const gap = 180;
  const step = 132;
  function place(bot, level) {
    depth = Math.max(depth, level);
    const reports = children.get(bot.id);
    const xs = reports.map(report => place(report, level + 1));
    const x = xs.length ? (xs[0] + xs.at(-1)) / 2 : cardWidth / 2 + 20 + gap * leaves++;
    points.set(bot.id, { x, y: 27 + (level - 1) * step, level });
    return x;
  }
  place(root, 1);
  return { bots, children, points, depth, width: 40 + cardWidth + (leaves - 1) * gap,
    height: 27 + (depth - 1) * step + cardHeight + 34 };
}

function renderDiagram(bots) {
  const key = bots.map(bot => bot.id + '/' + bot.managerId).join(',');
  if (diagram?.key === key) return;
  const newDiagram = buildDiagram(bots);
  const hadDiagram = !!diagram;
  diagram = { ...newDiagram, key };
  $('chart-empty').hidden = true;
  $('chart-space').hidden = false;
  $('chart').style.width = diagram.width + 'px';
  $('chart').style.height = diagram.height + 'px';
  $('edges').setAttribute('viewBox', '0 0 ' + diagram.width + ' ' + diagram.height);

  for (const bot of bots) {
    const { x, y, level } = diagram.points.get(bot.id);
    let entry = nodeElements.get(bot.id);
    if (!entry) {
      const button = el('button', 'bot-card');
      button.type = 'button';
      if (hadDiagram) button.classList.add('entering');
      button.addEventListener('click', () => {
        selectedBot = bot.id;
        renderBotStates();
      });
      const identity = el('div', 'bot-identity');
      const mark = el('span', 'bot-mark ' + (level === 1 ? 'root-mark' : ''));
      mark.append(icon(level === 1 ? 'org' : 'bot'));
      const titles = el('span', 'bot-titles');
      const name = el('strong', '', bot.name);
      const role = el('small', '', bot.role);
      titles.append(name, role);
      identity.append(mark, titles);
      const state = el('div', 'bot-state');
      const dot = el('i', 'dot');
      const label = el('span');
      state.append(dot, label);
      button.append(identity, state);
      $('nodes').append(button);
      entry = { button, dot, label };
      nodeElements.set(bot.id, entry);
    }
    entry.button.style.left = (x - cardWidth / 2) + 'px';
    entry.button.style.top = y + 'px';
    if (!bot.managerId) continue;
    const parent = diagram.points.get(bot.managerId);
    let edge = edgeElements.get(bot.id);
    if (!edge) {
      edge = document.createElementNS(SVG, 'path');
      $('edges').append(edge);
      edgeElements.set(bot.id, edge);
    }
    const y1 = parent.y + cardHeight;
    const midpoint = (y1 + y) / 2;
    edge.setAttribute('d', 'M ' + parent.x + ' ' + y1 + ' V ' + midpoint + ' H ' + x + ' V ' + y);
  }
  applyZoom();
}

function applyZoom() {
  if (!diagram) return;
  if (fit) zoom = Math.min(1, Math.max(0.65, ($('viewport').clientWidth - 18) / diagram.width));
  $('chart-space').style.width = Math.ceil(diagram.width * zoom) + 'px';
  $('chart-space').style.height = Math.ceil(diagram.height * zoom) + 'px';
  $('chart').style.transform = 'scale(' + zoom + ')';
  $('zoom-label').textContent = Math.round(zoom * 100) + '%';
}

function zoomBy(step) {
  if (!diagram) return;
  fit = false;
  zoom = Math.min(1.5, Math.max(0.55, Math.round((zoom + step) * 100) / 100));
  applyZoom();
}

function botStatus(jobs) {
  if (jobs.some(task => task.status === 'running')) return 'running';
  if (jobs.some(task => task.status === 'queued')) return 'queued';
  if (jobs[0]?.status === 'failed') return 'failed';
  return 'idle';
}

function renderBotStates() {
  const jobs = new Map(snapshot.bots.map(bot => [bot.id, []]));
  for (const task of snapshot.tasks) jobs.get(task.botId).push(task);
  const activeEdges = new Set();
  const statuses = new Map();
  const byId = new Map(snapshot.bots.map(bot => [bot.id, bot]));
  for (const bot of snapshot.bots) {
    const state = botStatus(jobs.get(bot.id));
    statuses.set(bot.id, state);
    const entry = nodeElements.get(bot.id);
    entry.button.dataset.status = state;
    entry.button.setAttribute('aria-pressed', String(bot.id === selectedBot));
    entry.dot.className = 'dot ' + state;
    entry.label.textContent = statusNames[state];
    if (state === 'running') {
      for (let child = bot; child.managerId; child = byId.get(child.managerId)) activeEdges.add(child.id);
    }
  }
  for (const [id, edge] of edgeElements) edge.classList.toggle('flow', activeEdges.has(id));
  $('active-count').textContent = [...statuses.values()].filter(status => status === 'running').length;
  $('queued-count').textContent = snapshot.tasks.filter(task => task.status === 'queued').length;
  renderInspector(byId.get(selectedBot), byId, statuses.get(selectedBot), jobs.get(selectedBot));
}

function renderInspector(bot, byId, status, jobs) {
  const wrapper = $('inspector');
  if (!bot) return;
  const previouslyOpen = new Set([...wrapper.querySelectorAll('details[open]')].map(item => item.dataset.task));
  const heading = el('div', 'inspector-person');
  const avatar = el('span', 'panel-icon person-icon');
  avatar.append(icon('bot'));
  const titles = el('div');
  titles.append(el('strong', '', bot.name), el('small', '', bot.role));
  heading.append(avatar, titles, badge(status));
  const definition = el('dl', 'bot-definition');
  definition.append(
    el('dt', '', '直属上级'), el('dd', '', bot.managerId ? byId.get(bot.managerId).name : '集团 Chief'),
    el('dt', '', '岗位职责'), el('dd', '', bot.mission)
  );
  const list = el('div', 'bot-jobs');
  list.append(el('h3', '', '最近任务'));
  if (!jobs.length) list.append(el('p', 'placeholder', '该员工暂时没有任务。'));
  for (const job of jobs.slice(0, 5)) {
    const detail = el('details', 'job');
    detail.dataset.task = job.id;
    detail.open = previouslyOpen.has(job.id) || job.status === 'running';
    const title = el('summary');
    title.append(el('span', '', job.title), badge(job.status));
    const brief = el('p', 'job-brief', job.brief);
    const result = el('pre', 'result', job.output ?? '');
    result.hidden = !job.output;
    detail.append(title, el('p', 'job-sender', '派发人 · ' + (job.delegatedBy ?? 'Chief')), brief, result);
    if (job.truncated) {
      const more = el('button', 'more', '读取完整内容');
      more.type = 'button';
      const scope = companyId;
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const full = await api('/api/companies/' + scope + '/tasks/' + job.id);
          brief.textContent = full.brief;
          result.textContent = full.output ?? '';
          result.hidden = !full.output;
          more.remove();
        } catch {
          more.disabled = false;
          more.textContent = '加载失败，重试';
        }
      });
      detail.append(more);
    }
    list.append(detail);
  }
  wrapper.replaceChildren(heading, definition, list);
}

function renderTimeline() {
  $('activity').replaceChildren(...snapshot.activity.map(entry => {
    const item = el('li');
    const status = entry.kind.endsWith('failed') ? 'failed'
      : entry.kind.endsWith('started') ? 'running' : entry.kind.endsWith('queued') ? 'queued' : 'idle';
    item.append(el('i', 'dot ' + status), el('span', '', entry.detail),
      el('time', '', time.format(entry.createdAt)));
    return item;
  }));
}

function renderMessages() {
  const thread = $('messages');
  if (!snapshot.requests.length) {
    thread.replaceChildren(el('p', 'placeholder', '告诉 Chief 你想达成什么目标，或请它组建团队。'));
    return;
  }
  const follow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
  thread.replaceChildren(...snapshot.requests.toReversed().map(request => {
    const exchange = el('article', 'exchange');
    const user = el('div', 'message user');
    const chief = el('div', 'message chief-message');
    user.append(el('strong', '', '你'), el('p', '', request.prompt));
    const status = request.status === 'running' ? 'Chief 正在分析…' : '已进入 Chief 队列…';
    chief.append(el('strong', '', 'Chief'), el('p', '', request.output ?? status));
    if (request.status === 'failed') chief.append(badge('failed'));
    exchange.append(user, chief);
    return exchange;
  }));
  if (follow) thread.scrollTop = thread.scrollHeight;
}

function render() {
  if (!selectedBot) selectedBot = snapshot.bots.find(bot => bot.managerId === null).id;
  renderDiagram(snapshot.bots);
  $('staff-count').textContent = snapshot.bots.length;
  $('depth-count').textContent = diagram.depth;
  renderBotStates();
  renderMessages();
  renderTimeline();
  const planning = snapshot.requests.some(request => request.status === 'running');
  const queued = snapshot.requests.some(request => request.status === 'queued');
  $('chief-status').hidden = !planning && !queued;
  $('chief-status').replaceChildren(badge(planning ? 'running' : 'queued', planning ? '编排中' : '等候中'));
  updateControls();
}

async function submit(prompt) {
  if (sending || !companyId || !prompt.trim()) return;
  const target = companyId;
  sending = true;
  showError('');
  updateControls();
  try {
    await api('/api/companies/' + target + '/chief', { prompt });
    if (target === companyId && $('prompt').value === prompt) $('prompt').value = '';
  } catch (error) {
    showError(error.message);
  } finally {
    sending = false;
    updateControls();
  }
}

$('zoom-out').addEventListener('click', () => zoomBy(-0.15));
$('zoom-in').addEventListener('click', () => zoomBy(0.15));
$('zoom-fit').addEventListener('click', () => { fit = true; applyZoom(); });
new ResizeObserver(() => { if (fit) applyZoom(); }).observe($('viewport'));
$('chief-form').addEventListener('submit', event => {
  event.preventDefault();
  void submit($('prompt').value);
});
$('run-demo').addEventListener('click', () => void submit('请组建一个交付团队并安排第一轮工作。'));

const dialog = $('create-dialog');
for (const id of ['create-company', 'nav-create']) {
  $(id).addEventListener('click', () => {
    $('create-error').hidden = true;
    dialog.showModal();
  });
}
$('cancel-create').addEventListener('click', () => dialog.close());
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('confirm-create').disabled = true;
  $('create-error').hidden = true;
  try {
    const { company } = await api('/api/companies', {
      name: $('company-name').value,
      mission: $('new-mission').value
    });
    companies.push(company);
    openCompany(company.id);
    dialog.close();
    event.target.reset();
  } catch (error) {
    $('create-error').textContent = error.message;
    $('create-error').hidden = false;
  } finally {
    $('confirm-create').disabled = false;
  }
});

try {
  ({ companies, mode } = await api('/api/companies'));
  $('mode').textContent = mode === 'demo' ? '演示模式' : 'DeepSeek';
  $('mode').hidden = false;
  if (mode === 'demo') $('composer-note').textContent = '当前使用预设演示流程，工作结果为示例。';
  const previous = localStorage.getItem('bot-org-hq.current');
  renderEmpty();
  renderCompanies();
  openCompany(companies.find(company => company.id === previous)?.id ?? companies[0]?.id ?? null);
  if (!companyId) connection('本地服务就绪', 'running');
} catch (error) {
  showError(error.message);
  connection('连接失败', 'failed');
}
