(() => {
  const form = document.querySelector('#registrationForm');
  const registrationSuccess = document.querySelector('#registrationSuccess');
  const toast = document.querySelector('#toast');
  const fields = [...form.querySelectorAll('.field')];
  const DEVICE_ID_KEY = 'hu_registration_device_id';
  let registrationConfirmed = false;
  const getDeviceId = () => {
    try {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (!id) {
        if (crypto.randomUUID) id = crypto.randomUUID();
        else {
          const bytes = crypto.getRandomValues(new Uint8Array(16));
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          id = [...bytes].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('');
        }
        localStorage.setItem(DEVICE_ID_KEY, id);
      }
      return id;
    } catch { return ''; }
  };
  const digits = value => String(value).replace(/[٠-٩۰-۹]/g, char => {
    const index = '٠١٢٣٤٥٦٧٨٩'.indexOf(char);
    return String(index < 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(char) : index);
  });
  const normalizePhone = value => digits(value).replace(/[\s()-]/g, '').replace(/^\+?962/, '0');
  const readEntries = async () => {
    try {
      const response = await fetch('/api/admin/registrants', { headers: { Accept: 'application/json' } });
      if (!response.ok) return [];
      const result = await response.json();
      return Array.isArray(result.registrants) ? result.registrants : [];
    } catch { return []; }
  };
  const showToast = message => { toast.textContent = message; toast.classList.add('toast-visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('toast-visible'), 3400); };
  const mark = (field, error = '') => { const errorNode = field.querySelector('.field-error'); const input = field.querySelector('input,select'); errorNode.textContent = error; field.classList.toggle('field-invalid', Boolean(error)); field.classList.toggle('field-valid', !error && Boolean(input.value.trim())); return !error; };
  const errorFor = (input, allEntries) => {
    const value = input.value.trim();
    if (input.name === 'fullName') {
      if (!value) return 'يرجى إدخال الاسم الرباعي.';
      if (value.replace(/\s+/g, ' ').split(' ').length < 4) return 'يرجى كتابة الاسم من أربعة مقاطع.';
    }
    if (input.name === 'phone') {
      const phone = normalizePhone(value);
      if (!value) return 'يرجى إدخال رقم الهاتف.';
      if (!/^07[789]\d{7}$/.test(phone)) return 'أدخل رقماً أردنياً صحيحاً مثل 0791234567.';
      if (allEntries.some(entry => normalizePhone(entry.phone) === phone)) return 'هذا الرقم مسجّل مسبقاً.';
    }
    if (input.name === 'email') {
      const email = value.toLowerCase();
      if (!value) return 'يرجى إدخال البريد الإلكتروني.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return 'أدخل بريداً إلكترونياً صحيحاً.';
      if (allEntries.some(entry => entry.email.toLowerCase() === email)) return 'هذا البريد مسجّل مسبقاً.';
    }
    if (['major', 'year'].includes(input.name) && !value) return 'يرجى اختيار ' + (input.name === 'major' ? 'التخصص.' : 'السنة الدراسية.');
    return '';
  };
  const validate = (field, entries) => mark(field, errorFor(field.querySelector('input,select'), entries));
  fields.forEach(field => {
    const input = field.querySelector('input,select');
    input.addEventListener('blur', () => { if (input.value.trim()) validate(field, []); });
    input.addEventListener('input', () => { if (field.classList.contains('field-invalid')) validate(field, []); });
    input.addEventListener('change', () => { if (field.classList.contains('field-invalid')) validate(field, []); });
  });
  form.querySelector('[name="consent"]').addEventListener('change', event => event.target.closest('.consent').classList.toggle('consent-invalid', !event.target.checked));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    // A browser-side flag can outlive a deleted database row. The database
    // remains authoritative; the server enforces duplicates during submit.
    const results = fields.map(field => validate(field, []));
    const checkbox = form.querySelector('[name="consent"]');
    checkbox.closest('.consent').classList.toggle('consent-invalid', !checkbox.checked);
    if (!results.every(Boolean) || !checkbox.checked) {
      const firstInvalid = form.querySelector('.field-invalid input,.field-invalid select');
      if (firstInvalid) firstInvalid.focus(); else checkbox.focus();
      showToast(!checkbox.checked && results.every(Boolean) ? 'يرجى الموافقة على استخدام بياناتك.' : 'تحقق من البيانات المدخلة ثم حاول مرة أخرى.');
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    const entry = { fullName: data.fullName.trim().replace(/\s+/g, ' '), phone: normalizePhone(data.phone), email: data.email.trim().toLowerCase(), major: data.major, year: data.year, consent: true, deviceId: getDeviceId() };
    const submitButton = form.querySelector('.submit-button');
    submitButton.disabled = true;
    submitButton.querySelector('.submit-text').textContent = 'جارٍ حفظ التسجيل…';
    try {
      const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(entry) });
      // A 201 is sent only after the database insert succeeds. Render the
      // confirmation as soon as those headers arrive; parsing the response
      // body must not be able to block the success state.
      if (response.ok) {
        showRegisteredState(entry.fullName, 'success');
        form.reset(); fields.forEach(field => { field.classList.remove('field-valid', 'field-invalid'); field.querySelector('.field-error').textContent = ''; });
        return;
      }
      let result = {};
      try { result = await response.json(); } catch {}
      if (response.status === 409) {
        if (result.field === 'device') {
          showAlreadyRegistered();
          return;
        }
        // Older registrations may predate device tracking. A duplicate phone
        // or email still means this submitted registration already exists.
        if (result.field === 'phone' || result.field === 'email') {
          showRegisteredState('', 'duplicate');
          return;
        }
        const duplicateField = form.querySelector(`[name="${result.field}"]`);
        if (duplicateField) { mark(duplicateField.closest('.field'), result.message); duplicateField.focus(); }
        showToast(result.message || 'يوجد تسجيل سابق باستخدام هذه البيانات.');
        return;
      }
      if (!response.ok) {
        if (response.status === 503) showToast('التسجيل غير متاح حالياً. يرجى المحاولة لاحقاً.');
        else showToast(result.message || 'تعذر حفظ التسجيل. تحقق من البيانات وحاول مرة أخرى.');
        return;
      }
    } catch {
      showToast('تعذر الاتصال بالخادم. تحقق من اتصال الإنترنت ثم حاول مجدداً.');
      return;
    } finally {
      submitButton.disabled = false;
      submitButton.querySelector('.submit-text').textContent = 'إرسال طلب التسجيل';
    }
  });
  function escapeHtml(text) { return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function showRegisteredState(fullName = '', state = 'already') {
    registrationConfirmed = true;
    form.hidden = true;
    registrationSuccess.hidden = false;
    document.querySelector('#successTitle').innerHTML = 'أنت مسجل<span>.</span>';
    const isSuccess = state === 'success';
    const isDuplicate = state === 'duplicate';
    document.querySelector('#successEyebrow').textContent = isSuccess ? 'اكتمل التسجيل بنجاح' : isDuplicate ? 'تم العثور على تسجيل سابق' : 'تم التحقق من حالة التسجيل';
    document.querySelector('#successMessage').innerHTML = isSuccess ? `أهلاً <b>${escapeHtml(fullName)}</b>، تم تأكيد تسجيلك.` : isDuplicate ? 'رقم الهاتف أو البريد الإلكتروني الذي أدخلته مرتبط بطلب تسجيل سابق.' : 'سبق لهذا الجهاز إكمال طلب التسجيل.';
    document.querySelector('#successDetail').innerHTML = isSuccess ? 'سنكون على تواصل معك قريباً.<br><b>نتمنى لك رحلة مليئة بالإنجاز!</b>' : isDuplicate ? 'تم حفظ طلب التسجيل من قبل.<br><b>لا حاجة لإرساله مرة أخرى.</b>' : 'نحافظ على عدالة الفرصة للجميع.<br><b>لا يمكن إرسال طلب آخر من هذا الجهاز.</b>';
    registrationSuccess.classList.toggle('device-already-registered', !isSuccess);
    document.querySelector('#successDeviceNote').classList.toggle('device-already-registered', !isSuccess);
    registrationSuccess.classList.add('registration-success-visible');
  }
  function showAlreadyRegistered() {
    showRegisteredState();
  }
  async function restoreRegisteredState() {
    try {
      const deviceId = getDeviceId();
      const response = await fetch('/api/register/status', {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'X-Registration-Device': deviceId }
      });
      if (!response.ok) return;
      const result = await response.json();
      if (registrationConfirmed) return;
      if (result.registered) {
        showRegisteredState();
      } else {
        form.hidden = false;
        registrationSuccess.hidden = true;
      }
    } catch {
      // If the database cannot confirm a registration, never show a stale
      // success screen based on data stored only in this browser.
      if (!registrationConfirmed) {
        form.hidden = false;
        registrationSuccess.hidden = true;
      }
    }
  }
  restoreRegisteredState();
  const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); } }), { threshold: 0.1 });
  document.querySelectorAll('.reveal').forEach(element => observer.observe(element));
})();
