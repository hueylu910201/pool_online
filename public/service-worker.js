// 這個專案不使用 Service Worker。
// 若瀏覽器裡殘留其他曾在同一網址（例如 localhost:3000）執行過的 PWA Service Worker，
// 它會攔截請求並回傳舊網站的頁面。這支腳本會取代它、清掉快取、解除註冊並重新載入頁面。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
