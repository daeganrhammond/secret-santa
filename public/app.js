const $ = id => document.getElementById(id);
const organizer = location.pathname === '/organizer' || new URLSearchParams(location.search).has('organizer');
const isLocal = ['localhost','127.0.0.1','::1'].includes(location.hostname);
const remoteApi = isLocal && !new URLSearchParams(location.search).has('live') ? '' : window.SANTA_CONFIG?.apiUrl || '';
let adminToken = '';
try { adminToken = sessionStorage.getItem('santa-admin') || ''; } catch {}
let state;
let joined;
try { joined = JSON.parse(localStorage.getItem('santa-joined') || 'null'); } catch {}
document.body.classList.toggle('organizer', organizer);
$('join-card').hidden = organizer;
$('organizer-card').hidden = !organizer;

function message(text) { $('message').textContent = text; $('message').hidden = !text; }
async function api(path, data) {
  if (remoteApi) {
    const response = await fetch(remoteApi, { method:'POST', redirect:'follow', credentials:'omit',
      headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify({ ...data, action:path.replace(/^\//,''), token:adminToken }) });
    const envelope = await response.json();
    if (!envelope.ok) { const error=new Error(envelope.error || 'Could not complete this request.'); error.status=envelope.status;throw error; }
    if (path === '/login') { adminToken=envelope.data.token; try { sessionStorage.setItem('santa-admin',adminToken); } catch {} }
    if (path === '/admin/logout') { adminToken=''; try { sessionStorage.removeItem('santa-admin'); } catch {} }
    return envelope.data;
  }
  if (!['localhost','127.0.0.1','::1'].includes(location.hostname)) throw new Error('The email workshop is still being connected. Please come back once setup is complete.');
  const response = await fetch(`/api${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Could not complete this request.'); error.status = response.status; throw error; }
  return result;
}
async function busy(form, action) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(b => { b.dataset.disabled = String(b.disabled); b.disabled = true; });
  form.setAttribute('aria-busy','true'); message('');
  try { await action(); } catch (e) { message(e.message || 'Could not connect. Please try again.'); }
  finally { form.removeAttribute('aria-busy'); buttons.forEach(b => { b.disabled = b.dataset.disabled === 'true'; }); if (organizer && state) renderAdmin(state); }
}
async function refreshPublic() {
  try {
    if (joined?.receipt) {
      const current = await api('/receipt', { receipt:joined.receipt });
      if (!current.joined) { joined=null; try { localStorage.removeItem('santa-joined'); } catch {} }
    }
    const { count, drawn } = await api('/status');
    $('count').textContent = `${count} / 6`;
    $('progress-text').textContent = drawn ? 'The names have been drawn' : count === 6 ? 'All six Santas are here!' : 'A little more magic on the way';
    [...$('slots').children].forEach((slot, i) => slot.classList.toggle('filled',i < count));
    $('signup-view').hidden = Boolean(joined) || count === 6 || drawn;
    $('joined-view').hidden = !joined;
    $('closed-view').hidden = Boolean(joined) || (count < 6 && !drawn);
    if (joined) $('joined-description').textContent = drawn ? `${joined.name}, the draw is complete! Look out for an email with your two names.` : `${joined.name}, your spot is saved. Now for a little Christmas magic.`;
    if (drawn) { $('closed-title').textContent = 'The secrets are out.'; $('closed-description').textContent = 'The draw is complete and the organizer can check email delivery. Already joined? Keep an eye on your inbox.'; }
  } catch { $('progress-text').textContent = 'Could not check the list'; message('We could not connect to the workshop. Please refresh in a moment.'); }
}
$('join-form').addEventListener('submit', e => {
  e.preventDefault(); busy(e.currentTarget, async () => {
    const result = await api('/join', { name: $('name').value, email: $('email').value });
    joined = { name: result.name, receipt: result.receipt };
    try { localStorage.setItem('santa-joined',JSON.stringify(joined)); } catch {}
    await refreshPublic();
  });
});
const statusText = { joined: 'On the list', pending: 'Waiting to send', sending: 'Sending…', sent: 'Email sent', failed: 'Send failed', review: 'Check delivery' };
function renderAdmin(data) {
  state = data;
  $('login-view').hidden = true; $('admin-view').hidden = false;
  $('people-list').replaceChildren();
  for (const person of data.people) {
    const row = document.createElement('div'); row.className = 'person';
    const info = document.createElement('div'); info.className = 'person-info';
    const name = document.createElement('strong'); name.textContent = person.name;
    const email = document.createElement('small'); email.textContent = person.email; info.append(name,email);
    const status = document.createElement('span'); status.className = 'person-status'; status.textContent = statusText[person.status] || person.status;
    row.append(info,status);
    if (!data.drawn) {
      const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${person.name}`);
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${person.name} from the nice list? They can join again with corrected details.`)) return;
        busy($('admin-view'), async () => renderAdmin(await api('/admin/remove', { id: person.id })));
      }); row.append(remove);
    }
    $('people-list').append(row);
  }
  if (!data.people.length) { const p = document.createElement('p'); p.className='card-description'; p.textContent='No Santas yet. Share the main signup link to get started.'; $('people-list').append(p); }
  $('email-warning').hidden = data.emailReady;
  $('draw-button').disabled = data.drawn || data.people.length !== 6 || !data.emailReady;
  $('draw-label').textContent = data.drawn ? 'The names are drawn' : 'Draw & email the names';
  $('draw-hint').textContent = data.drawn ? 'The secrets are safely saved' : !data.emailReady ? 'Connect an email sender to continue' : data.people.length === 6 ? 'Six Santas. Twelve surprises. Ready?' : `${data.people.length} of 6 Santas have joined`;
  $('retry-button').hidden = !data.drawn || !data.people.some(p => p.status === 'failed' || p.status === 'pending');
  $('delivery-note').hidden = !data.drawn;
  $('admin-description').textContent = data.drawn ? 'The draw is locked. Check each email’s sending status below.' : 'Check everyone’s details, then tap the stocking to draw and email the names.';
}
async function refreshAdmin() {
  try { renderAdmin(await api('/admin')); }
  catch (e) { if (e.status === 401) { state = null; $('login-view').hidden=false; $('admin-view').hidden=true; } else throw e; }
}
$('login-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { await api('/login',{ password:$('password').value }); $('password').value=''; await refreshAdmin(); }); });
$('draw-button').addEventListener('click', () => {
  if (!confirm('Draw the names and send six assignment emails? The draw is final and cannot be rerun.')) return;
  busy($('admin-view'), async () => { $('draw-hint').textContent = 'Making magic… please keep this page open'; renderAdmin(await api('/admin/draw',{})); });
});
$('retry-button').addEventListener('click', () => busy($('admin-view'), async () => renderAdmin(await api('/admin/retry',{}))));
$('refresh-button').addEventListener('click', () => busy($('admin-view'),refreshAdmin));
$('logout-button').addEventListener('click', () => busy($('admin-view'), async () => { await api('/admin/logout',{}); state=null; $('admin-view').hidden=true; $('login-view').hidden=false; }));
if (organizer) refreshAdmin().catch(e => message(e.message)); else { refreshPublic(); setInterval(refreshPublic,15000); }
