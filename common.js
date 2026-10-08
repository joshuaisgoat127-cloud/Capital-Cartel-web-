async function api(url, options = {}) {
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  const res = await fetch(url, opts);
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = body;
    throw err;
  }
  return body;
}
function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso));
}
function badgeClass(status='') { return String(status).toLowerCase(); }
function toast(message) {
  const old = document.querySelector('.toast'); if (old) old.remove();
  const el = document.createElement('div'); el.className='toast'; el.textContent=message; document.body.appendChild(el);
  setTimeout(()=>el.remove(),4200);
}
function switchSection(id) {
  document.querySelectorAll('.section').forEach(x=>x.classList.toggle('active',x.id===id));
  document.querySelectorAll('[data-section]').forEach(x=>x.classList.toggle('active',x.dataset.section===id));
  const title = document.querySelector(`[data-section="${id}"]`)?.textContent?.trim();
  if (title) document.querySelector('#pageTitle').textContent = title;
  document.querySelector('.sidebar')?.classList.remove('open');
}
async function logout(){ try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{} location.href='/login.html'; }
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64); return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push notifications are not supported in this browser');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');
  const reg = await navigator.serviceWorker.register('/sw.js');
  const { publicKey } = await api('/api/push/public-key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:urlBase64ToUint8Array(publicKey) });
  await api('/api/push/subscribe',{method:'POST',body:JSON.stringify({subscription:sub.toJSON()})});
  return true;
}
