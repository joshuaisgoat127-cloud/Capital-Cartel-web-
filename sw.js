self.addEventListener('push', event => {
  let data = { title:'Capital Cartel', body:'New trading update', url:'/dashboard.html' };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body:data.body,
    icon:'/icon.svg',
    badge:'/icon.svg',
    data:{url:data.url || '/dashboard.html'},
    tag:'capital-cartel-trade',
    renotify:true
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list => {
    const target = event.notification.data?.url || '/dashboard.html';
    for (const client of list) { if ('focus' in client) { client.navigate(target); return client.focus(); } }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});
