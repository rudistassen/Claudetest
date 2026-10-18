import { api, confirmDialog, esc, field, fmtDate, input, isDemo, openModal, showError, textarea, toast } from '../lib.js';
import { hydrateMedia, shrinkImage, toBase64 } from './mybrew.js';

// Chat: group chats set up by managers. Each person sees the chats they're in, reads them and replies (text or a
// photo). An open chat checks for new messages every few seconds.

const POLL_MS = 4000;
const photoUrl = (groupId, messageId) => `/api/chat/${groupId}/photos/${messageId}`;
// The standalone demo has no real server, so its photos are loaded through fetch (see hydrateMedia).
const photoSrc = (groupId, messageId) => (isDemo ? `data-src="${photoUrl(groupId, messageId)}"` : `src="${photoUrl(groupId, messageId)}"`);
const changed = () => window.dispatchEvent(new Event('chat:read'));

// When a message was sent: the time today, otherwise the day and time.
const london = (sqlUtc) => new Date(`${sqlUtc.replace(' ', 'T')}Z`);
const dayOf = (sqlUtc) => london(sqlUtc).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const timeOf = (sqlUtc) => london(sqlUtc).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const todayLondon = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
function when(sqlUtc) {
  const day = dayOf(sqlUtc);
  if (day === todayLondon()) return timeOf(sqlUtc);
  const days = Math.round((new Date(todayLondon()) - new Date(day)) / 86400000);
  if (days === 1) return 'Yesterday';
  return days < 7 ? fmtDate(day, { weekday: 'short' }) : fmtDate(day, { day: 'numeric', month: 'short' });
}
function dayLabel(day) {
  const days = Math.round((new Date(todayLondon()) - new Date(day)) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long' });
}

// Message text with line breaks kept and web links made clickable.
const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// --- The list of chats ---

export async function renderList({ el, stale }) {
  const data = await api('/chat');
  if (stale()) return;
  const row = (g) => `<a class="chat-row ${g.unread ? 'is-unread' : ''}" href="#/chat/${g.id}">
      <span class="chat-avatar ${g.kind === 'direct' || g.answering ? 'is-person' : g.kind === 'team' ? 'is-team' : ''}" aria-hidden="true">${esc(initials(g.name))}</span>
      <span class="chat-row-text">
        <span class="chat-row-top"><strong>${esc(g.name)}${g.answering ? ` <span class="chat-team-tag">to ${esc(g.team)}</span>` : ''}</strong>${g.last ? `<small>${esc(when(g.last.created_at))}</small>` : ''}</span>
        <span class="chat-row-last">${g.last ? `${g.last.mine ? 'You: ' : g.kind === 'direct' || (g.kind === 'team' && !g.answering) ? '' : `${esc(g.last.author ?? 'Someone')}: `}${esc(g.last.body)}` : `<em>${esc(g.description || 'No messages yet – say hello')}</em>`}</span>
      </span>
      ${g.muted ? '<span class="chat-muted" title="Notifications muted">🔕</span>' : ''}
      ${g.unread ? `<span class="nav-badge">${g.unread}</span>` : ''}
    </a>`;
  el.innerHTML = `<div class="chat-page">
    <div class="page-head"><h1>Chat</h1>
      <div class="actions">${data.can_direct ? `<button type="button" class="btn ${data.can_create ? '' : 'btn-primary'}" id="chat-direct">✉ Message someone</button>` : ''}${data.can_create ? '<button type="button" class="btn btn-primary" id="chat-new">+ New group chat</button>' : ''}</div></div>
    ${data.teams?.length ? `<section class="chat-teams"><h2>Chat with</h2><div class="chat-team-picks">${data.teams.map((t) => `<button type="button" class="chat-team-pick" data-team="${t.id}" title="${esc(t.description ?? '')}">
        <span class="chat-avatar small is-team" aria-hidden="true">${esc(initials(t.name))}</span><span><strong>${esc(t.name)}</strong>${t.description ? `<small>${esc(t.description)}</small>` : ''}</span></button>`).join('')}</div>
      <p class="muted small">A private chat – only you and that team see it.</p></section>` : ''}
    ${data.groups.length ? `<div class="card chat-list">${data.groups.map(row).join('')}</div>`
      : `<div class="card empty">${data.can_create ? 'No chats yet. Start a group with <strong>+ New group chat</strong> and choose who’s in it.' : 'You’re not in any chats yet. When a manager adds you to a group chat, it shows up here.'}${data.can_direct ? ' To talk to one person, use <strong>✉ Message someone</strong>.' : ''}</div>`}
  </div>`;
  el.querySelector('#chat-new')?.addEventListener('click', () => editChat(null));
  el.querySelector('#chat-direct')?.addEventListener('click', startDirect);
  el.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { location.hash = `#/chat/${(await api('/chat/team', { method: 'POST', body: { team_id: Number(b.dataset.team) } })).id}`; } catch (err) { showError(err); b.disabled = false; }
  }));
}

// --- One chat ---

export async function renderChat({ el, params, stale, navigate }) {
  const groupId = Number(params[0]);
  const data = await api(`/chat/${groupId}`);
  if (stale()) return;
  let { group } = data;
  const direct = group.kind === 'direct';
  const team = group.kind === 'team';
  const messages = new Map(data.messages.map((m) => [m.id, m]));
  let more = data.more;
  const lastId = () => Math.max(0, ...messages.keys());

  el.innerHTML = `<div class="chat-room">
    <div class="chat-head">
      <a class="btn btn-small" href="#/chat" aria-label="All chats">‹ Chats</a>
      <button type="button" class="chat-title" id="chat-members" title="Who’s in this chat">
        <strong>${esc(group.name)}</strong><small>${team ? (group.answering ? `To ${esc(group.team)} · you reply as ${esc(group.team)}` : `Private chat with ${esc(group.team)}${group.description ? ` · ${esc(group.description)}` : ''}`) : direct ? 'Direct message · admins can read direct messages' : `${data.members.length} ${data.members.length === 1 ? 'person' : 'people'}${group.description ? ` · ${esc(group.description)}` : ''}`}</small>
      </button>
      <button type="button" class="btn btn-small" id="chat-mute" title="Phone notifications for this chat">${group.muted ? '🔕 Unmute' : '🔔 Mute'}</button>
      ${group.can_edit ? '<button type="button" class="btn btn-small" id="chat-edit">Edit</button>' : ''}
    </div>
    <div class="chat-messages" id="chat-messages" aria-live="polite"></div>
    <form class="chat-compose" id="chat-compose" autocomplete="off">
      <label class="chat-photo-btn" title="Add a photo"><input type="file" accept="image/*" id="chat-photo" hidden><span aria-hidden="true">📷</span><span class="sr-only">Add a photo</span></label>
      <div class="chat-input">
        <div class="chat-photo-preview" id="chat-photo-preview" hidden></div>
        <textarea name="body" rows="1" maxlength="4000" placeholder="${team && group.answering ? `Reply as ${esc(group.team)}` : `Message ${esc(group.name)}`}" aria-label="Message"></textarea>
      </div>
      <button type="submit" class="btn btn-primary chat-send">Send</button>
    </form>
  </div>`;

  const box = el.querySelector('#chat-messages');
  const form = el.querySelector('#chat-compose');
  const text = form.querySelector('textarea');
  const fileInput = el.querySelector('#chat-photo');
  const preview = el.querySelector('#chat-photo-preview');
  let photo = null;

  const bubble = (m, prev) => {
    const day = dayOf(m.created_at);
    const newDay = !prev || dayOf(prev.created_at) !== day;
    const sameAuthor = !newDay && prev && prev.user_id === m.user_id && prev.author === m.author && london(m.created_at) - london(prev.created_at) < 5 * 60000;
    return `${newDay ? `<div class="chat-day"><span>${esc(dayLabel(day))}</span></div>` : ''}
      <div class="chat-msg ${m.mine ? 'is-mine' : ''} ${sameAuthor ? 'is-cont' : ''} ${m.deleted_at ? 'is-deleted' : ''}" data-id="${m.id}">
        ${!m.mine && !sameAuthor && !direct ? `<span class="chat-author">${esc(m.author ?? 'Someone who has left')}</span>` : ''}
        <div class="chat-bubble">
          ${m.deleted_at ? '<em>Message deleted</em>' : `${m.has_photo ? `<button type="button" class="chat-img" data-photo="${m.id}" aria-label="Open photo"><img ${photoSrc(groupId, m.id)} alt="Photo" loading="lazy"></button>` : ''}${m.body ? `<p>${linkify(m.body)}</p>` : ''}`}
          <span class="chat-meta">${m.mine && m.as_team ? `as ${esc(m.as_team)} · ` : ''}${esc(timeOf(m.created_at))}${m.can_delete ? ` · <button type="button" class="link-btn" data-delete="${m.id}">Delete</button>` : ''}</span>
        </div>
      </div>`;
  };
  const draw = ({ toBottom = false } = {}) => {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const fromBottom = box.scrollHeight - box.scrollTop;
    const list = [...messages.values()].sort((a, b) => a.id - b.id);
    box.innerHTML = `${more ? '<div class="chat-more"><button type="button" class="btn btn-small" id="chat-older">Show earlier messages</button></div>' : ''}
      ${list.length ? list.map((m, i) => bubble(m, list[i - 1])).join('') : '<p class="chat-empty muted">No messages yet. Say hello 👋</p>'}`;
    hydrateMedia(box);
    if (toBottom || atBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = box.scrollHeight - fromBottom;
  };
  draw({ toBottom: true });
  // Pictures arriving after the first draw would push the latest messages out of view.
  box.addEventListener('load', (e) => { if (e.target.tagName === 'IMG' && box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight; }, true);

  const markRead = () => {
    if (!lastId() || document.hidden) return;
    api(`/chat/${groupId}/read`, { method: 'POST', body: { last_id: lastId() } }).then(changed).catch(() => {});
  };
  markRead();

  // New messages (and ones deleted since) every few seconds while the chat is open.
  let polling = false;
  const poll = async () => {
    if (polling || stale() || !box.isConnected) return;
    polling = true;
    try {
      const next = await api(`/chat/${groupId}?after=${lastId()}`);
      if (stale()) return;
      let fresh = next.messages.length > 0;
      for (const m of next.messages) messages.set(m.id, m);
      for (const gone of next.deleted) {
        const m = messages.get(gone);
        if (m && !m.deleted_at) { messages.set(gone, { ...m, deleted_at: 'now', body: '', has_photo: false, can_delete: false }); fresh = true; }
      }
      if (fresh) { draw(); markRead(); }
    } catch { /* try again next time */ } finally { polling = false; }
  };
  const timer = setInterval(() => (stale() || !box.isConnected ? clearInterval(timer) : poll()), POLL_MS);
  const onVisible = () => { if (stale() || !box.isConnected) document.removeEventListener('visibilitychange', onVisible); else if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);

  box.addEventListener('click', async (e) => {
    const older = e.target.closest('#chat-older');
    if (older) {
      older.disabled = true;
      try {
        const page = await api(`/chat/${groupId}?before=${Math.min(...messages.keys())}`);
        for (const m of page.messages) messages.set(m.id, m);
        more = page.more;
        draw();
      } catch (err) { showError(err); older.disabled = false; }
      return;
    }
    const del = e.target.closest('[data-delete]');
    if (del) {
      if (!(await confirmDialog('Delete this message for everyone in the chat?', { confirmLabel: 'Delete', title: 'Delete message' }))) return;
      try {
        await api(`/chat/${groupId}/messages/${del.dataset.delete}`, { method: 'DELETE' });
        const m = messages.get(Number(del.dataset.delete));
        messages.set(m.id, { ...m, deleted_at: 'now', body: '', has_photo: false, can_delete: false });
        draw();
      } catch (err) { showError(err); }
      return;
    }
    const img = e.target.closest('[data-photo]');
    if (img) openModal({ title: 'Photo', wide: true, body: `<img class="news-full" src="${img.querySelector('img').src}" alt="">` });
  });

  // The message box grows with what's typed (up to a few lines).
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 140)}px`; };
  text.addEventListener('input', grow);
  // On a computer Enter sends (Shift+Enter for a new line); on a phone Enter is a new line and Send sends.
  const touch = window.matchMedia('(pointer: coarse)').matches;
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });

  const showPhoto = () => {
    preview.hidden = !photo;
    preview.innerHTML = photo ? `<img src="${URL.createObjectURL(photo)}" alt=""><button type="button" class="icon-btn" id="chat-photo-clear" aria-label="Remove photo">×</button>` : '';
    preview.querySelector('#chat-photo-clear')?.addEventListener('click', () => { photo = null; fileInput.value = ''; showPhoto(); });
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try { photo = await shrinkImage(file); showPhoto(); text.focus(); } catch (err) { showError(err); fileInput.value = ''; }
  });

  let sending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = text.value.trim();
    if ((!body && !photo) || sending) return;
    sending = true;
    form.querySelector('.chat-send').disabled = true;
    try {
      const sent = await api(`/chat/${groupId}/messages`, {
        method: 'POST',
        body: { body, photo: photo ? { file_name: photo.name, media_type: photo.type, data: await toBase64(photo) } : null },
      });
      messages.set(sent.id, sent);
      text.value = '';
      photo = null;
      fileInput.value = '';
      showPhoto();
      grow();
      draw({ toBottom: true });
    } catch (err) { showError(err); } finally {
      sending = false;
      form.querySelector('.chat-send').disabled = false;
      if (!touch) text.focus();
    }
  });

  el.querySelector('#chat-members').addEventListener('click', () => openModal(team ? {
    title: group.answering ? `${group.name} · to ${group.team}` : `Chat with ${group.team}`,
    body: group.answering ? `<p class="muted small">${esc(group.name)} started this chat with ${esc(group.team)}. Everyone who answers for ${esc(group.team)} sees it, and your replies show as ${esc(group.team)}.</p>
      <p><strong>Answering for ${esc(group.team)}:</strong></p><ul class="chat-people">${data.members.filter((u) => u.answers).map((u) => `<li><span class="chat-avatar small" aria-hidden="true">${esc(initials(u.name))}</span>${esc(u.name)}</li>`).join('')}</ul>`
      : `<p>Only you and the ${esc(group.team)} team can see this chat. Their replies show as ${esc(group.team)}.</p>`,
  } : {
    title: direct ? `Direct message with ${group.name}` : `Who’s in ${group.name}`,
    body: `${direct ? '<p class="muted small">Only the two of you can see these messages – and Atlas admins, who can read direct messages if they need to.</p>' : ''}${group.all_sites ? '<p class="muted small">Everyone at every site is in this chat.</p>' : group.site_ids.length ? '<p class="muted small">Everyone at the chat’s sites is in it, as well as anyone added by name.</p>' : ''}
      <ul class="chat-people">${data.members.map((u) => `<li><span class="chat-avatar small" aria-hidden="true">${esc(initials(u.name))}</span>${esc(u.name)}${u.location_name ? ` <small class="muted">${esc(u.location_name)}</small>` : ''}</li>`).join('')}</ul>`,
  }));
  el.querySelector('#chat-mute').addEventListener('click', async (e) => {
    try {
      const r = await api(`/chat/${groupId}/mute`, { method: 'POST', body: { muted: !group.muted } });
      group = { ...group, muted: r.muted };
      e.target.textContent = r.muted ? '🔕 Unmute' : '🔔 Mute';
      toast(r.muted ? 'You won’t get phone notifications for this chat' : 'Phone notifications for this chat are on');
      changed();
    } catch (err) { showError(err); }
  });
  el.querySelector('#chat-edit')?.addEventListener('click', () => editChat(groupId, navigate));
}

// --- Setting a chat up: its name and who's in it ---

async function editChat(groupId, navigate) {
  const [options, current] = await Promise.all([api('/chat-setup/people'), groupId ? api(`/chat-setup/${groupId}`) : null]).catch((err) => { showError(err); return []; });
  if (!options) return;
  const g = current ?? { name: '', description: '', all_sites: false, site_ids: [], member_ids: [] };
  const sites = new Set(g.site_ids);
  const picked = new Set(g.member_ids);
  const { form } = openModal({
    title: groupId ? 'Edit chat' : 'New chat',
    wide: true,
    submitLabel: groupId ? 'Save' : 'Start chat',
    body: `${field('Name', input('name', g.name, 'required maxlength="80" placeholder="e.g. Common team, Managers, Kitchen"'))}
      ${field('What it’s for (optional)', textarea('description', g.description, 'rows="2" maxlength="300"'))}
      <fieldset class="chat-who">
        <legend>Who’s in it</legend>
        ${options.can_all || g.all_sites ? `<label class="check"><input type="checkbox" name="all_sites" ${g.all_sites ? 'checked' : ''}> <span><strong>Everyone</strong> – every person at every site</span></label>` : ''}
        <div class="chat-who-detail" ${g.all_sites ? 'hidden' : ''}>
          ${options.sites.length ? `<p class="muted small">Everyone at a site – people who join that site later are added automatically:</p>
          <div class="chat-site-picks">${options.sites.map((s) => `<label class="check"><input type="checkbox" data-site="${s.id}" ${sites.has(s.id) ? 'checked' : ''}> <span>Everyone at ${esc(s.name)}</span></label>`).join('')}</div>` : ''}
          <p class="muted small">And/or particular people:</p>
          <input type="search" class="chat-people-search" placeholder="Search people" aria-label="Search people">
          <div class="chat-people-picks">${options.people.map((u) => `<label class="check" data-name="${esc(`${u.name} ${u.location_name ?? ''} ${u.rota_group ?? ''}`.toLowerCase())}"><input type="checkbox" data-person="${u.id}" ${picked.has(u.id) ? 'checked' : ''}> <span>${esc(u.name)} <small class="muted">${esc(u.location_name ?? '')}${u.rota_group ? ` · ${esc(u.rota_group)}` : ''}</small></span></label>`).join('')}</div>
          <p class="muted small chat-picked-count"></p>
        </div>
      </fieldset>`,
    danger: groupId ? 'Delete chat' : null,
    onDanger: async () => {
      if (!(await confirmDialog(`Delete “${g.name}” and all its messages for everyone? This can’t be undone.`, { confirmLabel: 'Delete chat', title: 'Delete chat' }))) return;
      await api(`/chat/${groupId}`, { method: 'DELETE' });
      toast('Chat deleted');
      changed();
      location.hash = '#/chat';
    },
    onSubmit: async (v, f) => {
      const body = {
        name: v.name,
        description: v.description,
        all_sites: !!v.all_sites,
        site_ids: [...f.querySelectorAll('[data-site]:checked')].map((c) => Number(c.dataset.site)),
        member_ids: [...f.querySelectorAll('[data-person]:checked')].map((c) => Number(c.dataset.person)),
      };
      const saved = await api(groupId ? `/chat/${groupId}` : '/chat', { method: groupId ? 'PUT' : 'POST', body });
      toast(groupId ? 'Chat saved' : 'Chat started');
      if (groupId && navigate) navigate(`chat/${saved.id}`);
      else location.hash = `#/chat/${saved.id}`;
    },
  });
  const detail = form.querySelector('.chat-who-detail');
  const count = form.querySelector('.chat-picked-count');
  const showCount = () => {
    const n = form.querySelectorAll('[data-person]:checked').length;
    count.textContent = n ? `${n} ${n === 1 ? 'person' : 'people'} chosen by name` : '';
  };
  showCount();
  form.querySelector('[name=all_sites]')?.addEventListener('change', (e) => { detail.hidden = e.target.checked; });
  form.querySelector('.chat-people-picks').addEventListener('change', showCount);
  form.querySelector('.chat-people-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    form.querySelectorAll('.chat-people-picks [data-name]').forEach((l) => { l.hidden = !!q && !l.dataset.name.includes(q); });
  });
}

// --- Direct messages: pick someone at your sites ---

async function startDirect() {
  let people;
  try { people = await api('/chat/direct/people'); } catch (err) { showError(err); return; }
  const { form, close } = openModal({
    title: 'Message someone',
    body: people.length ? `<input type="search" class="chat-people-search" placeholder="Search people" aria-label="Search people">
      <div class="chat-dm-picks">${people.map((u) => `<button type="button" class="chat-dm-pick" data-person="${u.id}" data-name="${esc(`${u.name} ${u.location_name ?? ''} ${u.rota_group ?? ''}`.toLowerCase())}">
        <span class="chat-avatar small is-person" aria-hidden="true">${esc(initials(u.name))}</span>
        <span>${esc(u.name)} <small class="muted">${esc(u.location_name ?? '')}${u.rota_group ? ` · ${esc(u.rota_group)}` : ''}</small></span></button>`).join('')}</div>
      <p class="muted small">You can message people at your sites. Only the two of you see the conversation – and Atlas admins, who can read direct messages if they need to.</p>`
      : '<p>There’s nobody at your sites to message yet.</p>',
  });
  form.querySelector('.chat-people-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    form.querySelectorAll('.chat-dm-pick').forEach((b) => { b.hidden = !!q && !b.dataset.name.includes(q); });
  });
  form.querySelectorAll('.chat-dm-pick').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const chat = await api('/chat/direct', { method: 'POST', body: { user_id: Number(b.dataset.person) } });
      close();
      location.hash = `#/chat/${chat.id}`;
    } catch (err) { showError(err); b.disabled = false; }
  }));
}

// --- Setup → Direct messages (admins): read any one-to-one conversation. Each one opened goes in the Staff log. ---

export async function renderDirectAdmin({ el, stale }) {
  const list = await api('/chat-admin/direct');
  if (stale()) return;
  el.innerHTML = `<div class="chat-page">
    <div class="page-head"><h1>Direct messages</h1></div>
    <p class="muted">Every one-to-one conversation between staff. Opening one is recorded in the <a href="#/admin/staff-log">Staff log</a>. Staff are told admins can read direct messages.</p>
    ${list.length ? `<div class="card chat-list">${list.map((c) => `<a class="chat-row" href="#/admin/direct-messages/${c.id}">
        <span class="chat-avatar is-person" aria-hidden="true">${esc(initials(c.people[0]?.name))}</span>
        <span class="chat-row-text">
          <span class="chat-row-top"><strong>${c.people.map((p) => esc(p.name)).join(' & ')}</strong><small>${c.last_at ? esc(when(c.last_at)) : ''}</small></span>
          <span class="chat-row-last">${c.messages} message${c.messages === 1 ? '' : 's'}${c.people.some((p) => p.location_name) ? ` · ${[...new Set(c.people.map((p) => p.location_name).filter(Boolean))].map(esc).join(', ')}` : ''}</span>
        </span></a>`).join('')}</div>`
      : '<div class="card empty">No direct messages yet.</div>'}
  </div>`;
}

export async function renderDirectAdminView({ el, params, stale }) {
  const c = await api(`/chat-admin/direct/${Number(params[0])}`);
  if (stale()) return;
  const first = c.people[0]?.id;
  const src = (m) => {
    const url = `/api/chat-admin/direct/${c.id}/photos/${m.id}`;
    return isDemo ? `data-src="${url}"` : `src="${url}"`;
  };
  let prevDay = null;
  const bubbles = c.messages.map((m) => {
    const day = dayOf(m.created_at);
    const head = day !== prevDay ? `<div class="chat-day"><span>${esc(dayLabel(day))}</span></div>` : '';
    prevDay = day;
    // The first person's messages on the right, the other's on the left.
    return `${head}<div class="chat-msg ${m.user_id === first ? 'is-mine' : ''} ${m.deleted_at ? 'is-deleted' : ''}">
      <span class="chat-author">${esc(m.author ?? 'Someone who has left')}</span>
      <div class="chat-bubble">${m.deleted_at ? '<em>Message deleted</em>' : `${m.has_photo ? `<button type="button" class="chat-img" aria-label="Open photo"><img ${src(m)} alt="Photo" loading="lazy"></button>` : ''}${m.body ? `<p>${linkify(m.body)}</p>` : ''}`}
        <span class="chat-meta">${esc(timeOf(m.created_at))}</span></div></div>`;
  }).join('');
  el.innerHTML = `<div class="chat-room is-readonly">
    <div class="chat-head">
      <a class="btn btn-small" href="#/admin/direct-messages">‹ Direct messages</a>
      <div class="chat-title"><strong>${c.people.map((p) => esc(p.name)).join(' & ')}</strong><small>Read only · this look is recorded in the Staff log</small></div>
    </div>
    <div class="chat-messages">${bubbles || '<p class="chat-empty muted">No messages.</p>'}</div>
  </div>`;
  const box = el.querySelector('.chat-messages');
  hydrateMedia(box);
  box.scrollTop = box.scrollHeight;
  box.addEventListener('click', (e) => {
    const img = e.target.closest('.chat-img');
    if (img) openModal({ title: 'Photo', wide: true, body: `<img class="news-full" src="${img.querySelector('img').src}" alt="">` });
  });
}

// --- Setup → Chat teams (admins): the teams people can chat with, and who answers for each ---

export async function renderTeams({ el, stale, rerender }) {
  const data = await api('/chat-teams');
  if (stale()) return;
  el.innerHTML = `<div class="chat-page">
    <div class="page-head"><h1>Chat teams</h1><div class="actions"><button type="button" class="btn btn-primary" id="team-add">+ Add team</button></div></div>
    <p class="muted">Anyone can start a private chat with these teams from <a href="#/chat">Chat</a>. The people you choose for a team see every chat with it and reply as the team. A team only shows in Chat once someone answers for it.</p>
    <div class="card chat-list">${data.teams.map((t) => `<button type="button" class="chat-row chat-team-row" data-edit="${t.id}">
        <span class="chat-avatar is-team" aria-hidden="true">${esc(initials(t.name))}</span>
        <span class="chat-row-text">
          <span class="chat-row-top"><strong>${esc(t.name)}${t.active ? '' : ' <span class="badge badge-cancelled">Hidden</span>'}</strong><small>${t.chats} chat${t.chats === 1 ? '' : 's'}</small></span>
          <span class="chat-row-last">${t.answerers.length ? `Answered by ${t.answerers.map((a) => esc(a.name)).join(', ')}` : '<span class="tone-warn">Nobody answers yet – not shown in Chat</span>'}</span>
        </span></button>`).join('') || '<p class="empty">No teams yet.</p>'}</div>
  </div>`;
  const edit = (t) => {
    const picked = new Set((t?.answerers ?? []).map((a) => a.id));
    const { form } = openModal({
      title: t ? `Edit ${t.name}` : 'Add a chat team',
      wide: true,
      submitLabel: 'Save',
      body: `${field('Name', input('name', t?.name ?? '', 'required maxlength="60" placeholder="e.g. Payroll"'))}
        ${field('What it’s for (optional)', input('description', t?.description ?? '', 'maxlength="200" placeholder="Shown under the name in Chat"'))}
        <fieldset class="chat-who"><legend>Who answers for this team</legend>
          <p class="muted small">They see every chat with this team and reply as “${esc(t?.name ?? 'the team')}”.</p>
          <input type="search" class="chat-people-search" placeholder="Search people" aria-label="Search people">
          <div class="chat-people-picks">${data.people.map((u) => `<label class="check" data-name="${esc(`${u.name} ${u.location_name ?? ''}`.toLowerCase())}"><input type="checkbox" data-person="${u.id}" ${picked.has(u.id) ? 'checked' : ''}> <span>${esc(u.name)} <small class="muted">${esc(u.location_name ?? '')}</small></span></label>`).join('')}</div>
        </fieldset>
        <label class="check"><input type="checkbox" name="active" ${!t || t.active ? 'checked' : ''}> <span>Show this team in Chat</span></label>`,
      danger: t ? 'Delete team' : null,
      onDanger: async () => {
        if (!(await confirmDialog(`Delete ${t.name} and its ${t.chats} chat${t.chats === 1 ? '' : 's'} for everyone? This can’t be undone. To stop new chats but keep the old ones, untick “Show this team in Chat” instead.`, { confirmLabel: 'Delete team', title: 'Delete team' }))) return;
        await api(`/chat-teams/${t.id}`, { method: 'DELETE' });
        toast('Team deleted');
        rerender();
      },
      onSubmit: async (v, f) => {
        const body = { name: v.name, description: v.description, active: !!v.active, answerer_ids: [...f.querySelectorAll('[data-person]:checked')].map((c) => Number(c.dataset.person)) };
        await api(t ? `/chat-teams/${t.id}` : '/chat-teams', { method: t ? 'PUT' : 'POST', body });
        toast('Team saved');
        rerender();
      },
    });
    form.querySelector('.chat-people-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      form.querySelectorAll('.chat-people-picks [data-name]').forEach((l) => { l.hidden = !!q && !l.dataset.name.includes(q); });
    });
  };
  el.querySelector('#team-add').addEventListener('click', () => edit(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(data.teams.find((t) => t.id === Number(b.dataset.edit)))));
}
