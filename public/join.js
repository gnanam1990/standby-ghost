import { api } from '/api.js';

const token = decodeURIComponent(location.pathname.replace(/^\/join\//, ''));
const $ = (id) => document.getElementById(id);

if (!token || token === 'join.html' || token === location.pathname) {
  $('join-status').textContent = 'This link is not a valid invitation.';
  $('join-btn').disabled = true;
}

$('join-btn').addEventListener('click', async () => {
  const name = $('join-name').value.trim();
  const { ok, data } = await api('POST', '/api/join', { token, name });
  if (!ok) {
    $('join-status').textContent = data?.message ?? 'Could not join.';
    $('join-status').classList.add('error');
    return;
  }
  localStorage.setItem(`sg-session:${data.roomId}`, data.sessionToken);
  localStorage.setItem(`sg-member:${data.roomId}`, JSON.stringify(data.member));
  $('join-status').textContent = '';
  $('joined').hidden = false;
  $('joined-info').textContent =
    `You are ${data.member.name} — ${data.member.role} (generation ${data.member.generation}).`;
  $('room-link').href = `/room.html?room=${encodeURIComponent(data.roomId)}`;
  $('room-link').focus();
});
