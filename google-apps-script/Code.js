/* Secret Santa backend. Deploy as a Web App: execute as Me, access Anyone.
 * This script needs permission to SEND email, not to read your inbox.
 * Set ADMIN_PASSWORD in Project Settings > Script properties (10+ characters).
 * Keep this source and the organizer password separate from participant data.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || e.postData.contents.length > 4096) throw santaError_(400, 'Invalid request.');
    var input;
    try { input = JSON.parse(e.postData.contents); } catch (_) { throw santaError_(400, 'Invalid request.'); }
    return santaOutput_({ ok: true, data: santaHandle_(input) });
  } catch (error) {
    return santaOutput_({ ok: false, status: error.status || 500, error: error.status ? error.message : 'The workshop could not complete that request. Please try again.' });
  }
}
function doGet() { return santaOutput_({ ok: true, service: 'Secret Santa', version: 1 }); }
function santaOutput_(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
function santaError_(status, text) { var error = new Error(text); error.status = status; return error; }
function santaHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8).map(function (n) { return ('0' + (n & 255).toString(16)).slice(-2); }).join('');
}
function santaToken_() { return Utilities.getUuid() + Utilities.getUuid(); }
function santaRead_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('SANTA_STATE') || '{"people":[],"draw":null}');
}
function santaSave_(state) { PropertiesService.getScriptProperties().setProperty('SANTA_STATE', JSON.stringify(state)); }
function santaAuth_(input) {
  if (typeof input.token !== 'string' || !CacheService.getScriptCache().get('session:' + santaHash_(input.token))) throw santaError_(401, 'Please sign in as the organizer.');
}
function santaAdmin_(state) {
  return { drawn: !!state.draw, emailReady: true, people: state.people.map(function (p) { return { id:p.id, name:p.name, email:p.email, status:p.status || 'joined' }; }) };
}
function santaHandle_(input) {
  if (!input || typeof input.action !== 'string') throw santaError_(400, 'Invalid request.');
  var action = input.action;
  if (action.indexOf('admin') === 0) santaAuth_(input);
  if (action === 'admin/logout') { CacheService.getScriptCache().remove('session:' + santaHash_(input.token)); return { ok:true }; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw santaError_(409, 'The workshop is busy. Please refresh in a moment.');
  try {
    var state = santaRead_();
    if (action === 'status') return { count:state.people.length, drawn:!!state.draw };
    if (action === 'receipt') {
      var person = typeof input.receipt === 'string' ? state.people.find(function(p) { return p.receipt === santaHash_(input.receipt); }) : null;
      return { joined:!!person, name:person ? person.name : undefined };
    }
    if (action === 'login') {
      var cache = CacheService.getScriptCache();
      var attempts = Number(cache.get('loginAttempts') || 0);
      if (attempts >= 30) throw santaError_(429, 'Too many login attempts. Try again in 15 minutes.');
      cache.put('loginAttempts', String(attempts + 1), 900);
      var password = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
      if (!password || password.length < 10) throw santaError_(503, 'The organizer password has not been configured.');
      if (typeof input.password !== 'string' || input.password.length > 512 || santaHash_(input.password) !== santaHash_(password)) throw santaError_(401, 'That organizer password is incorrect.');
      var token = santaToken_();
      cache.put('session:' + santaHash_(token), 'yes', 21600);
      cache.remove('loginAttempts');
      return { ok:true, token:token };
    }
    if (action === 'join') {
      if (state.draw) throw santaError_(409, 'The draw has already happened.');
      if (state.people.length >= 6) throw santaError_(409, 'All six places are filled.');
      var name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
      var email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw santaError_(400, 'Please enter a name of 1–60 characters.');
      if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw santaError_(400, 'Please enter a valid email address.');
      if (state.people.some(function (p) { return p.email === email; })) throw santaError_(409, 'That email address has already joined.');
      if (state.people.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); })) throw santaError_(409, 'That name is already in use. Add a last name or initial.');
      var receipt = santaToken_();
      state.people.push({ id:Utilities.getUuid(), name:name, email:email, receipt:santaHash_(receipt), status:'joined' });
      santaSave_(state);
      return { joined:true, name:name, receipt:receipt };
    }
    if (action === 'admin') return santaAdmin_(state);
    if (action === 'admin/remove') {
      if (state.draw) throw santaError_(409, 'Participants are locked after the draw.');
      state.people = state.people.filter(function (p) { return p.id !== input.id; });
      santaSave_(state); return santaAdmin_(state);
    }
    if (action === 'admin/draw') {
      if (state.draw) throw santaError_(409, 'The draw is already saved. It cannot be rerun.');
      if (state.people.length !== 6) throw santaError_(409, 'All six people must join first.');
      if (MailApp.getRemainingDailyQuota() < 6) throw santaError_(503, 'Gmail’s daily sending allowance is too low. Try again tomorrow. No names have been drawn.');
      state.draw = { createdAt:new Date().toISOString(), assignments:santaDraw_(state.people.map(function (p) { return p.id; })) };
      state.people.forEach(function (p) { p.status='pending'; });
      santaSave_(state); // Save the immutable draw BEFORE any external sends.
      santaDeliver_(state); return santaAdmin_(state);
    }
    if (action === 'admin/retry') {
      if (!state.draw) throw santaError_(409, 'Draw the names first.');
      santaDeliver_(state); return santaAdmin_(state);
    }
    throw santaError_(404, 'Action not found.');
  } finally { lock.releaseLock(); }
}
function santaDeliver_(state) {
  var byId = {};
  state.people.forEach(function (p) { byId[p.id]=p; });
  // An interrupted previous execution may already have sent this message.
  state.people.forEach(function (p) { if (p.status === 'sending') p.status='review'; });
  santaSave_(state);
  state.people.forEach(function (person) {
    if (person.status !== 'pending') return;
    if (MailApp.getRemainingDailyQuota() < 1) return;
    var recipients = state.draw.assignments[person.id].map(function (id) { return byId[id].name; });
    person.status='sending'; santaSave_(state);
    try {
      MailApp.sendEmail({ to:person.email, subject:'Secret Santa: your two names 🎄', name:'Secret Santa',
        body:'Hi ' + person.name + '!\n\nYour Secret Santa recipients are:\n\n1. ' + recipients[0] + '\n2. ' + recipients[1] + '\n\nPlease buy one gift for each person. Keep your names a secret!\n\nEveryone is giving two gifts and receiving two gifts. Happy holidays!' });
      person.status='sent'; person.sentAt=new Date().toISOString();
    } catch (_) { person.status='review'; }
    santaSave_(state);
  });
}
function santaDraw_(ids) {
  if (ids.length !== 6 || new Set(ids).size !== 6) throw new Error('Exactly six distinct participants are required.');
  function randomInt(max) {
    // Rejection avoids modulo bias. The first eight UUID hex digits are random.
    var value, limit=Math.floor(4294967296/max)*max;
    do { value=parseInt(Utilities.getUuid().slice(0,8),16); } while(value >= limit);
    return value % max;
  }
  function shuffle() {
    var result=ids.slice();
    for(var i=result.length-1;i>0;i--) { var j=randomInt(i+1),swap=result[i];result[i]=result[j];result[j]=swap; }
    return result;
  }
  for (;;) {
    var first=shuffle(),second=shuffle();
    if(ids.every(function(id,i){return id!==first[i]&&id!==second[i]&&first[i]!==second[i];})) {
      var draw={};ids.forEach(function(id,i){draw[id]=[first[i],second[i]];});return draw;
    }
  }
}
