
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    const close = () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
    };
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const opened = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(opened));
      toggle.innerHTML = opened
        ? '<i class="fa-solid fa-xmark"></i>'
        : '<i class="fa-solid fa-bars"></i>';
    });
    document.addEventListener('click', e => {
      if (!nav.contains(e.target) && !toggle.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }
});

(() => {
  const TIME_LIMIT = 25000;
  const MAX_OVERLAY_MS = 4000;
  let overlayTimer = null;
  let watchdog = null;
  const pageLoader = () => document.getElementById('dugital-loader');
  const stopClock = () => { clearTimeout(watchdog); watchdog = null; };
  const hide = () => {
    stopClock();
    clearTimeout(overlayTimer);
    overlayTimer = null;
    pageLoader()?.classList.remove('is-visible');
    document.body.classList.remove('loading-dugital');
  };
  const fail = (message = 'Could not load Dugital. Please retry.') => {
    hide();
    const feed = document.getElementById('posts-feed');
    if (feed && (feed.querySelector('.loading-state') || !feed.children.length)) {
      feed.innerHTML = '<div class="loading-state" role="alert"></div>';
      const box = feed.firstElementChild;
      box.append(document.createTextNode(message + ' '));
      const retry = document.createElement('button');
      retry.className = 'retry-button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => location.reload());
      box.append(retry);
    } else if (document.body.classList.contains('auth-body')) {
      const el = document.getElementById('auth-error');
      if (el) el.textContent = message;
    } else {
      const existing = document.getElementById('dugital-connection-error');
      if (!existing) {
        const msg = document.createElement('div');
        msg.id = 'dugital-connection-error';
        msg.className = 'dugital-error-banner';
        msg.setAttribute('role', 'alert');
        msg.append(document.createTextNode(message + ' '));
        const retry = document.createElement('button');
        retry.className = 'retry-button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => location.reload());
        msg.append(retry);
        document.querySelector('.main-content')?.prepend(msg);
      }
    }
  };
  const show = (message = 'Loading your stories...') => {
    const el = pageLoader();
    if (!el) return;
    const caption = document.getElementById('loader-caption');
    if (caption) caption.textContent = message;
    el.classList.add('is-visible');
    document.body.classList.add('loading-dugital');
    clearTimeout(overlayTimer);
    
    overlayTimer = setTimeout(hide, MAX_OVERLAY_MS);
    stopClock();
    watchdog = setTimeout(() => {
      if (el.classList.contains('is-visible')) {
        fail('The connection is taking too long. Please try again.');
      }
    }, TIME_LIMIT);
  };
  window.DugitalLoader = { show, hide, fail };
  
  if (pageLoader()?.classList.contains('is-visible')) {
    show('Connecting to Dugital...');
  }
})();