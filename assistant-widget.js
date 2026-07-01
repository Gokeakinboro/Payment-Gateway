/* Paylode Portal Assistant — floating help widget.
   Config before loading:  window.PAYLODE_ASSISTANT = { mode: 'authed' | 'public' }
   authed → POST /api/v1/assistant/chat (Bearer paylode_token, role-aware)
   public → POST /api/v1/assistant/public-chat (no auth; sign-up help)
*/
(function () {
  var CFG = window.PAYLODE_ASSISTANT || { mode: 'public' };
  var AUTHED = CFG.mode === 'authed';
  var ENDPOINT = '/api/v1/assistant/' + (AUTHED ? 'chat' : 'public-chat');
  var GREETING = CFG.greeting || (AUTHED
    ? "Hi! I'm the Paylode assistant. Ask me how to use or navigate the portal."
    : "Hi! I'm the Paylode assistant. Ask me how to sign up or what Paylode can do for you.");
  var history = [];   // {role, content}
  var busy = false;

  var css = '' +
  '#pla-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;background:#1a2744;color:#fff;border:none;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;font-size:24px;transition:transform .15s,background .15s}' +
  '#pla-btn:hover{background:#253360;transform:translateY(-2px)}' +
  '#pla-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;font-family:\'DM Sans\',system-ui,-apple-system,Segoe UI,Arial,sans-serif}' +
  '#pla-panel.open{display:flex}' +
  '#pla-head{background:#1a2744;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}' +
  '#pla-head .d{width:32px;height:32px;border-radius:8px;background:#7dc534;color:#1a2744;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
  '#pla-head .t{font-size:14px;font-weight:700}#pla-head .s{font-size:11px;color:rgba(255,255,255,.65)}' +
  '#pla-head .x{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.7);font-size:22px;cursor:pointer;line-height:1}' +
  '#pla-msgs{flex:1;overflow-y:auto;padding:14px;background:#f4f6fb}' +
  '.pla-m{margin-bottom:10px;display:flex}' +
  '.pla-m.u{justify-content:flex-end}' +
  '.pla-b{max-width:80%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
  '.pla-m.a .pla-b{background:#fff;color:#1e293b;border:1px solid #e2e8f0;border-bottom-left-radius:4px}' +
  '.pla-m.u .pla-b{background:#1a2744;color:#fff;border-bottom-right-radius:4px}' +
  '.pla-typing{color:#64748b;font-size:12px;padding:2px 4px}' +
  '#pla-foot{border-top:1px solid #e2e8f0;padding:10px;display:flex;gap:8px;background:#fff}' +
  '#pla-in{flex:1;border:1.5px solid #cbd5e1;border-radius:8px;padding:9px 11px;font-size:13.5px;font-family:inherit;outline:none;resize:none;max-height:90px}' +
  '#pla-in:focus{border-color:#1a2744}' +
  '#pla-send{background:#7dc534;color:#1a2744;border:none;border-radius:8px;padding:0 14px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit}' +
  '#pla-send:disabled{opacity:.5;cursor:not-allowed}' +
  '.pla-foot-note{font-size:10px;color:#94a3b8;text-align:center;padding:0 10px 8px;background:#fff}';

  function el(tag, attrs, html) { var e = document.createElement(tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function mount() {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);

    var btn = el('button', { id: 'pla-btn', 'aria-label': 'Open help assistant', title: 'Need help?' }, '&#128172;');
    var panel = el('div', { id: 'pla-panel', role: 'dialog', 'aria-label': 'Paylode assistant' });
    panel.appendChild(el('div', { id: 'pla-head' },
      '<div class="d">P</div><div><div class="t">Paylode Assistant</div><div class="s">Portal help</div></div>' +
      '<button class="x" aria-label="Close">&times;</button>'));
    var msgs = el('div', { id: 'pla-msgs' }); panel.appendChild(msgs);
    var foot = el('div', { id: 'pla-foot' });
    var input = el('textarea', { id: 'pla-in', rows: '1', placeholder: 'Ask a question…' });
    var send = el('button', { id: 'pla-send' }, 'Send');
    foot.appendChild(input); foot.appendChild(send); panel.appendChild(foot);
    panel.appendChild(el('div', { class: 'pla-foot-note' }, 'AI assistant · may be imperfect · portal help only'));

    document.body.appendChild(btn); document.body.appendChild(panel);

    function open() { panel.classList.add('open'); if (!history.length) addMsg('a', GREETING); input.focus(); }
    function close() { panel.classList.remove('open'); }
    btn.addEventListener('click', function () { panel.classList.contains('open') ? close() : open(); });
    panel.querySelector('.x').addEventListener('click', close);

    function addMsg(role, text) {
      var row = el('div', { class: 'pla-m ' + (role === 'u' ? 'u' : 'a') });
      row.appendChild(el('div', { class: 'pla-b' }, esc(text)));
      msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight; return row;
    }

    async function submit() {
      var q = input.value.trim(); if (!q || busy) return;
      input.value = ''; input.style.height = 'auto';
      addMsg('u', q); history.push({ role: 'user', content: q });
      busy = true; send.disabled = true;
      var typing = el('div', { class: 'pla-m a' }, '<div class="pla-b pla-typing">…</div>'); msgs.appendChild(typing); msgs.scrollTop = msgs.scrollHeight;
      try {
        var headers = { 'Content-Type': 'application/json' };
        if (AUTHED) { var t = sessionStorage.getItem('paylode_token'); if (t) headers['Authorization'] = 'Bearer ' + t; }
        var res = await fetch(ENDPOINT, { method: 'POST', headers: headers, body: JSON.stringify({ messages: history.slice(-12) }) });
        var data = await res.json().catch(function () { return {}; });
        typing.remove();
        var reply = (data && data.data && data.data.reply) || data.message || 'Sorry, something went wrong. Please try again.';
        addMsg('a', reply);
        if (data && data.status !== false && data.data && data.data.reply) history.push({ role: 'assistant', content: reply });
      } catch (e) {
        typing.remove(); addMsg('a', 'I could not reach the assistant. Please check your connection and try again.');
      }
      busy = false; send.disabled = false; input.focus();
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 90) + 'px'; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
