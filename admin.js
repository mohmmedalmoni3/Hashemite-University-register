(() => {
  const table = document.querySelector('#registrantsTable');
  const emptyState = document.querySelector('#emptyState');
  const noResults = document.querySelector('#noResults');
  const search = document.querySelector('#searchInput');
  const login = document.querySelector('#adminLogin');
  const privateSections = [...document.querySelectorAll('.admin-heading,.admin-metrics,.admin-data-panel,.storage-note,.admin-main>.footer')];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ar-JO', { day: 'numeric', month: 'short', year: 'numeric' }).format(date); };
  const timeLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ar-JO', { hour: '2-digit', minute: '2-digit' }).format(date); };
  const showLogin = () => { login.hidden = false; privateSections.forEach(section => { section.hidden = true; }); };
  const showDashboard = () => { login.hidden = true; privateSections.forEach(section => { section.hidden = false; }); };
  async function fetchEntries() {
    const response = await fetch('/api/admin/registrants', { headers: { Accept: 'application/json' } });
    if (response.status === 401) { showLogin(); return null; }
    if (!response.ok) throw new Error('تعذر تحميل بيانات المسجلين.');
    return (await response.json()).registrants;
  }
  async function render() {
    let entries;
    try { entries = await fetchEntries(); }
    catch (error) { showLogin(); document.querySelector('#loginError').textContent = error.message; return; }
    if (!entries) return;
    showDashboard();
    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const query = search.value.trim().toLowerCase();
    const filtered = entries.filter(item => [item.fullName, item.email, item.phone, item.major, item.year].some(value => String(value || '').toLowerCase().includes(query)));
    document.querySelector('#totalCount').textContent = entries.length.toLocaleString('ar-JO');
    document.querySelector('#majorCount').textContent = new Set(entries.map(item => item.major).filter(Boolean)).size.toLocaleString('ar-JO');
    const last = entries[0];
    document.querySelector('#lastRegistration').textContent = last ? dateLabel(last.createdAt) : '—';
    document.querySelector('#lastRegistrationNote').textContent = last ? `الساعة ${timeLabel(last.createdAt)}` : 'لا توجد تسجيلات بعد';
    document.querySelector('#recordCount').textContent = `${entries.length.toLocaleString('ar-JO')} سجل`;
    document.querySelector('#tableSummary').textContent = `عرض ${filtered.length.toLocaleString('ar-JO')} من ${entries.length.toLocaleString('ar-JO')} مسجل`;
    document.querySelector('#updatedAt').textContent = new Intl.DateTimeFormat('ar-JO', { hour: '2-digit', minute: '2-digit' }).format(new Date());
    table.innerHTML = filtered.map(item => `<tr><td><div class="student-cell"><span class="student-avatar">${esc((item.fullName || '؟').trim().charAt(0))}</span><span><b>${esc(item.fullName)}</b><small>طلب تسجيل</small></span></div></td><td dir="ltr" class="ltr-cell">${esc(item.phone)}</td><td dir="ltr" class="ltr-cell">${esc(item.email)}</td><td><span class="major-tag">${esc(item.major)}</span></td><td>${esc(item.year)}</td><td>${esc(dateLabel(item.createdAt))}</td></tr>`).join('');
    emptyState.hidden = entries.length > 0;
    noResults.hidden = entries.length === 0 || filtered.length > 0;
    document.querySelector('#exportCsv').onclick = () => exportCsv(entries);
  }
  function exportCsv(entries) {
    if (!entries.length) { document.querySelector('#exportCsv').classList.add('export-empty'); setTimeout(() => document.querySelector('#exportCsv').classList.remove('export-empty'), 1800); return; }
    const rows = [['الاسم الرباعي', 'رقم الهاتف', 'البريد الإلكتروني', 'التخصص', 'السنة الدراسية', 'تاريخ التسجيل'], ...entries.map(item => [item.fullName, item.phone, item.email, item.major, item.year, item.createdAt])];
    const csv = '\ufeff' + rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `registrants-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  document.querySelector('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const error = document.querySelector('#loginError');
    error.textContent = '';
    button.disabled = true;
    try {
      const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      const result = await response.json();
      if (!response.ok) { error.textContent = result.message || 'تعذر تسجيل الدخول.'; return; }
      form.reset();
      await render();
    } catch { error.textContent = 'تعذر الاتصال بالخادم.'; }
    finally { button.disabled = false; }
  });
  document.querySelector('#logoutButton').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });
  search.addEventListener('input', render);
  render();
})();
