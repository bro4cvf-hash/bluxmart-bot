/* Bluxmart Admin — login */
const f = document.getElementById('f');
const err = document.getElementById('err');
const btn = document.getElementById('btn');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Sign in failed.');
    location.href = '/';
  } catch (ex) {
    err.textContent = ex.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
