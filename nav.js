// Genesis mobile menu: toggles the hamburger menu in the nav.
// No dependencies; loaded on every page after the nav markup.
(function () {
  var btn = document.getElementById('menuBtn');
  var menu = document.getElementById('mobileMenu');
  if (!btn || !menu) return;
  function setOpen(open) {
    menu.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    btn.querySelector('span').textContent = open ? '\u2715' : '\u2630';
  }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    setOpen(!menu.classList.contains('open'));
  });
  // Tapping a link (or the wallet button) closes the menu.
  menu.addEventListener('click', function (e) {
    if (e.target.closest('a, button')) setOpen(false);
  });
  // Tapping anywhere outside the nav closes it; Escape does too.
  document.addEventListener('click', function (e) {
    if (menu.classList.contains('open') && !e.target.closest('nav')) setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false);
  });
  // The mobile wallet button forwards to the real one in the desktop nav
  // (same wallet flow, one handler in app.js).
  var mobileWallet = document.getElementById('walletBtnMobile');
  var wallet = document.getElementById('walletBtn');
  if (mobileWallet && wallet) {
    mobileWallet.addEventListener('click', function () { wallet.click(); });
  }
})();
