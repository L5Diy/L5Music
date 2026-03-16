document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('l5token');
  const authed = localStorage.getItem('musicui_authed');
  if (!token || authed !== '1') {
    window.location.replace('login.html');
    return;
  }
  const toggleButton = document.getElementById('menu-toggle');
  const menu = document.querySelector('nav ul');
  if (toggleButton && menu) {
    toggleButton.addEventListener('click', () => { menu.classList.toggle('active'); });
  }
});
