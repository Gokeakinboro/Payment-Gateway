(function () {
  'use strict';

  var API_URL = window.PAYLODE_CHAT_API_URL || '/api/v1/chat';
  var PRIMARY = '#1a2744';
  var ACCENT = '#7dc534';
  var history = [];
  var open = false;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') {
        Object.keys(attrs.style).forEach(function (s) { node.style[s] = attrs.style[s]; });
      } else if (k === 'class') {
        node.className = attrs[k];
      } else {
        node[k] = attrs[k];
      }
    });
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  var css = `
    #plcw-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99998;
      width: 56px; height: 56px; border-radius: 50%;
      background: ${PRIMARY}; border: none; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s;
    }
    #plcw-btn:hover { transform: scale(1.08); }
    #plcw-btn svg { width: 26px; height: 26px; fill: #fff; }
    #plcw-panel {
      position: fixed; bottom: 92px; right: 24px; z-index: 99999;
      width: 330px; height: 480px; border-radius: 16px;
      background: #fff; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: 'DM Sans', system-ui, sans-serif; font-size: 14px;
      opacity: 0; pointer-events: none; transform: translateY(12px);
      transition: opacity 0.2s, transform 0.2s;
    }
    #plcw-panel.plcw-open { opacity: 1; pointer-events: all; transform: translateY(0); }
    #plcw-header {
      background: ${PRIMARY}; color: #fff; padding: 14px 16px;
      display: flex; align-items: center; gap: 10px; flex-shrink: 0;
    }
    #plcw-header-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: ${ACCENT}; display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px; color: ${PRIMARY}; flex-shrink: 0;
    }
    #plcw-header-info { flex: 1; }
    #plcw-header-name { font-weight: 600; font-size: 14px; }
    #plcw-header-status { font-size: 11px; opacity: 0.75; }
    #plcw-close {
      background: none; border: none; cursor: pointer; color: #fff;
      opacity: 0.7; padding: 4px; line-height: 1;
    }
    #plcw-close:hover { opacity: 1; }
    #plcw-msgs {
      flex: 1; overflow-y: auto; padding: 16px 12px; display: flex;
      flex-direction: column; gap: 10px; scroll-behavior: smooth;
    }
    .plcw-msg { max-width: 84%; line-height: 1.45; word-break: break-word; }
    .plcw-msg-bot {
      align-self: flex-start; background: #f1f5f9; color: #1e293b;
      padding: 9px 12px; border-radius: 4px 14px 14px 14px;
    }
    .plcw-msg-user {
      align-self: flex-end; background: ${PRIMARY}; color: #fff;
      padding: 9px 12px; border-radius: 14px 4px 14px 14px;
    }
    .plcw-typing {
      align-self: flex-start; background: #f1f5f9; color: #64748b;
      padding: 10px 14px; border-radius: 4px 14px 14px 14px;
      font-style: italic; font-size: 13px;
    }
    #plcw-footer {
      border-top: 1px solid #e2e8f0; padding: 10px 12px;
      display: flex; gap: 8px; flex-shrink: 0; background: #fff;
    }
    #plcw-input {
      flex: 1; border: 1px solid #cbd5e1; border-radius: 8px;
      padding: 8px 12px; font-size: 13px; font-family: inherit;
      outline: none; resize: none; line-height: 1.4; max-height: 80px;
      transition: border-color 0.15s;
    }
    #plcw-input:focus { border-color: ${ACCENT}; }
    #plcw-send {
      background: ${ACCENT}; border: none; border-radius: 8px;
      cursor: pointer; padding: 0 14px; color: ${PRIMARY};
      font-weight: 700; font-size: 13px; flex-shrink: 0;
      transition: background 0.15s;
    }
    #plcw-send:hover { background: #9ed44f; }
    #plcw-send:disabled { opacity: 0.5; cursor: not-allowed; }
    @media (max-width: 400px) {
      #plcw-panel { width: calc(100vw - 16px); right: 8px; bottom: 84px; }
    }
  `;

  var styleTag = document.createElement('style');
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  var btnIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>';
  var closeIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  var btn = el('button', { id: 'plcw-btn', title: 'Chat with Paylode Assistant' });
  btn.innerHTML = btnIcon;

  var panel = el('div', { id: 'plcw-panel' });
  var header = el('div', { id: 'plcw-header' });
  var avatar = el('div', { id: 'plcw-header-avatar' }, 'P');
  var headerInfo = el('div', { id: 'plcw-header-info' }, [
    el('div', { id: 'plcw-header-name' }, 'Paylode Assistant'),
    el('div', { id: 'plcw-header-status' }, 'Ask me anything about Paylode'),
  ]);
  var closeBtn = el('button', { id: 'plcw-close', title: 'Close chat' });
  closeBtn.innerHTML = closeIcon;
  header.appendChild(avatar);
  header.appendChild(headerInfo);
  header.appendChild(closeBtn);

  var msgs = el('div', { id: 'plcw-msgs' });
  var footer = el('div', { id: 'plcw-footer' });
  var input = el('textarea', { id: 'plcw-input', placeholder: 'Type your question…', rows: 1 });
  var sendBtn = el('button', { id: 'plcw-send' }, 'Send');
  footer.appendChild(input);
  footer.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(msgs);
  panel.appendChild(footer);
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  function addMsg(text, role) {
    var cls = role === 'user' ? 'plcw-msg plcw-msg-user' : 'plcw-msg plcw-msg-bot';
    var node = el('div', { class: cls }, text);
    msgs.appendChild(node);
    msgs.scrollTop = msgs.scrollHeight;
    return node;
  }

  function setTyping(show) {
    var existing = document.getElementById('plcw-typing');
    if (show && !existing) {
      var t = el('div', { id: 'plcw-typing', class: 'plcw-typing' }, 'Paylode is typing…');
      msgs.appendChild(t);
      msgs.scrollTop = msgs.scrollHeight;
    } else if (!show && existing) {
      existing.remove();
    }
  }

  function togglePanel() {
    open = !open;
    if (open) {
      panel.classList.add('plcw-open');
      if (msgs.children.length === 0) {
        addMsg('Hi! I\'m the Paylode Assistant. I can help you navigate the dashboard, understand our products, or answer integration questions. What would you like to know?', 'bot');
      }
      setTimeout(function () { input.focus(); }, 200);
    } else {
      panel.classList.remove('plcw-open');
    }
  }

  async function sendMessage() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = '';
    input.style.height = '';
    addMsg(text, 'user');
    history.push({ role: 'user', content: text });
    sendBtn.disabled = true;
    setTyping(true);
    try {
      var res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history.slice(-6) }),
      });
      var data = await res.json();
      var reply = data.reply || data.message || 'Sorry, something went wrong. Please try again.';
      setTyping(false);
      addMsg(reply, 'bot');
      history.push({ role: 'assistant', content: reply });
      if (history.length > 20) history = history.slice(-20);
    } catch (e) {
      setTyping(false);
      addMsg('Unable to reach the assistant right now. Please try again in a moment.', 'bot');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  btn.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', togglePanel);
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', function () {
    this.style.height = '';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });
})();
