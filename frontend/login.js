'use strict';
document.addEventListener('DOMContentLoaded', function () {
  const loginForm = document.getElementById('login-form');
  if (!loginForm) return;

  const usernameEl = document.getElementById('username');
  const passwordEl = document.getElementById('password');
  const rememberEl = document.getElementById('remember-user');

  // Restore saved username
  const saved = localStorage.getItem('l5_saved_user');
  if (saved && usernameEl) {
    usernameEl.value = saved;
    if (rememberEl) rememberEl.checked = true;
    // Auto-focus password if username prefilled
    if (passwordEl) passwordEl.focus();
  }

  // --- Custom modal ---
  function showLoginModal(message, status) {
    // Remove existing
    const old = document.getElementById('login-modal');
    if (old) old.remove();

    let style = 'warn';
    let title = 'Sign In Failed';
    let btnText = 'Try Again';
    if (status === 429) { style = 'danger'; title = 'Too Many Attempts'; }
    if (status === 403) { style = 'locked'; title = 'Account Locked'; btnText = 'OK'; }

    const overlay = document.createElement('div');
    overlay.id = 'login-modal';
    overlay.className = 'login-modal-overlay';
    overlay.innerHTML =
      '<div class="login-modal ' + style + '">' +
        '<h3>' + title + '</h3>' +
        '<p>' + escapeHtml(message) + '</p>' +
        '<button id="modal-dismiss">' + btnText + '</button>' +
      '</div>';
    document.body.appendChild(overlay);

    const btn = document.getElementById('modal-dismiss');
    btn.addEventListener('click', function () {
      overlay.remove();
      if (status !== 403 && passwordEl) { passwordEl.value = ''; passwordEl.focus(); }
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { btn.click(); }
    });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape' || e.key === 'Enter') { btn.click(); document.removeEventListener('keydown', handler); }
    });
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const username = usernameEl.value.trim();
    const password = passwordEl.value;
    if (!username) { showLoginModal('Please enter a username.', 401); return; }

    // Save or clear username preference
    if (rememberEl && rememberEl.checked) {
      localStorage.setItem('l5_saved_user', username);
    } else {
      localStorage.removeItem('l5_saved_user');
    }

    try {
      const resp = await fetch('/l5/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await resp.json();
      if (data.ok && data.token) {
        localStorage.setItem('l5token', data.token);
        localStorage.setItem('l5user', data.username);
        localStorage.setItem('l5role', data.role || 'user');
        localStorage.setItem('musicui_authed', '1');
        window.location.replace('index.html');
      } else {
        showLoginModal(data.error || 'Bad username or password.', resp.status);
      }
    } catch (err) {
      console.error(err);
      showLoginModal('Connection failed. Check your network.', 0);
    }
  });

  // --- Inline Signup (Request Access) ---
  const signupPanel = document.getElementById('signup-form');
  const signupEmailEl = document.getElementById('signup-email');
  const signupMessageEl = document.getElementById('signup-message');
  const signupForm = document.getElementById('signup-form');
  const openSignupBtn = document.getElementById('open-signup');

  if (openSignupBtn && signupPanel) {
    openSignupBtn.addEventListener('click', function () {
      const isHidden = signupPanel.hidden;
      signupPanel.hidden = !isHidden;
      if (isHidden && signupEmailEl) {
        signupEmailEl.focus();
      }
    });
  }

  if (signupForm && signupEmailEl && signupMessageEl) {
    signupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const email = signupEmailEl.value.trim();
      signupMessageEl.textContent = '';
      signupMessageEl.className = 'login-message';

      if (!email) {
        signupMessageEl.textContent = 'Please enter your email address.';
        signupMessageEl.classList.add('login-message--error');
        return;
      }

      const btn = document.getElementById('signup-submit');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Submitting...';
      }

      fetch('/l5/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Request Access';
          }

          if (data.ok) {
            signupMessageEl.textContent = data.message || 'Submitted! Check your email once approved.';
            signupMessageEl.classList.add('login-message--success');
            signupEmailEl.value = '';
          } else {
            signupMessageEl.textContent = data.error || 'Request failed. Please try again.';
            signupMessageEl.classList.add('login-message--error');
          }
        })
        .catch(function () {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Request Access';
          }
          signupMessageEl.textContent = 'Network error. Please try again.';
          signupMessageEl.classList.add('login-message--error');
        });
    });
  }
});
