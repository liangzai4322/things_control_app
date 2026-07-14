import { getBoxes, getSettings, invalidateDataCache, pullDataFromCloud } from './db.js';
import { renderHome } from './home.js';

const app = document.getElementById('app');
const ROUTE_MODULE_CACHE = {};

export function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}

export function checkOnline() {
  if (!navigator.onLine) {
    showToast('Offline. AI needs network.');
    return false;
  }
  return true;
}

export function openSheet(contentHtml, { height = '70vh', onClose } = {}) {
  const root = document.getElementById('bottom-sheet-root');
  root.innerHTML = `
    <div class="sheet-backdrop"></div>
    <section class="bottom-sheet" style="height:${height}">${contentHtml}</section>
  `;

  const backdrop = root.querySelector('.sheet-backdrop');
  const sheet = root.querySelector('.bottom-sheet');

  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    sheet.classList.add('show');
  });

  const close = () => {
    backdrop.classList.remove('show');
    sheet.classList.remove('show');
    setTimeout(() => {
      root.innerHTML = '';
      onClose?.();
    }, 220);
  };

  backdrop.addEventListener('click', close);

  let startY = 0;
  let moved = 0;
  sheet.addEventListener('touchstart', (event) => {
    startY = event.touches[0].clientY;
    moved = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (event) => {
    moved = event.touches[0].clientY - startY;
    if (moved > 0) sheet.style.transform = `translateY(${Math.min(moved, 120)}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (moved > 80) close();
    else sheet.style.transform = '';
  });

  return { root, sheet, close };
}

function applyTheme() {
  const mode = getSettings().themeMode;
  document.documentElement.dataset.theme = mode;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', mode === 'dark' ? '#141b2d' : '#f7774d');
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function resetViewPosition() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  app.scrollTop = 0;
  document.querySelectorAll('.scroll-area').forEach((element) => {
    element.scrollTop = 0;
  });
}

function maybeResetViewPosition(options = {}) {
  if (!options.preserveScroll) requestAnimationFrame(resetViewPosition);
}

function route(options = {}) {
  applyTheme();
  const parts = (location.hash || '#home').replace('#', '').split('/').filter(Boolean);
  const [path, param, subParam] = parts;

  if (path === 'home') {
    renderHome(app);
    maybeResetViewPosition(options);
    return;
  }

  if (path === 'box') {
    const load = ROUTE_MODULE_CACHE.box || import('./box-detail.js');
    ROUTE_MODULE_CACHE.box = load;
    load.then(({ renderBoxDetail }) => {
      renderBoxDetail(app, param);
      maybeResetViewPosition(options);
    });
    return;
  }

  if (path === 'settings') {
    const load = ROUTE_MODULE_CACHE.settings || import('./settings.js');
    ROUTE_MODULE_CACHE.settings = load;
    load.then(({ renderSettings }) => {
      renderSettings(app);
      maybeResetViewPosition(options);
    });
    return;
  }

  if (path === 'points') {
    const load = ROUTE_MODULE_CACHE.points || import('./points-page.js');
    ROUTE_MODULE_CACHE.points = load;
    load.then(({ renderPointsPage }) => {
      renderPointsPage(app, { refreshRemote: true }).then(() => maybeResetViewPosition(options));
    });
    return;
  }

  if (path === 'smallworld' || path === 'sw-settings' || (path === 'sw' && (param === 'pavilion' || param === 'tower') && subParam)) {
    const load = ROUTE_MODULE_CACHE.smallworld || import('./small-world.js');
    ROUTE_MODULE_CACHE.smallworld = load;
    load.then(({ renderSmallWorldMap, renderSmallWorldFloor, renderSmallWorldSettings }) => {
      if (path === 'smallworld') {
        renderSmallWorldMap(app);
        maybeResetViewPosition(options);
        return;
      }
      if (path === 'sw-settings') {
        renderSmallWorldSettings(app);
        maybeResetViewPosition(options);
        return;
      }
      renderSmallWorldFloor(app, param, subParam)
        .catch(() => {
          showToast('Floor data failed to load');
          location.hash = '#smallworld';
        })
        .then(() => maybeResetViewPosition(options));
    });
    return;
  }

  location.hash = '#home';
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('service-worker.js')
    .then((registration) => registration.update().catch(() => {}))
    .catch(() => {});
}

function setupAudioUnlock() {
  let audioUnlocked = false;
  document.addEventListener('touchstart', () => {
    if (audioUnlocked) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    ctx.resume();
    audioUnlocked = true;
  }, { once: true });
}

function setupKeyboardInsets() {
  if (!window.visualViewport) return;
  const update = () => {
    const inset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
  };
  window.visualViewport.addEventListener('resize', update);
  update();
}

async function syncCloudInBackground() {
  try {
    const pointsModule = await import('./points-store.js');
    const [taskResult] = await Promise.allSettled([
      pullDataFromCloud(),
      pointsModule.prewarmPointsData?.({ forceSource: true }),
    ]);
    if ((location.hash || '#home') === '#home') renderHome(app);
    if (taskResult.status === 'fulfilled' && taskResult.value === 'merged') {
      showToast('Cloud synced');
    }
  } catch {
    // no-op
  }
}

function warmupCriticalModules() {
  const runWarmup = () => {
    ROUTE_MODULE_CACHE.box = ROUTE_MODULE_CACHE.box || import('./box-detail.js');
    ROUTE_MODULE_CACHE.box.catch(() => {});
  };

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(runWarmup, { timeout: 2400 });
  } else {
    setTimeout(runWarmup, 1400);
  }
}

function scheduleBackgroundWork() {
  const run = () => {
    registerServiceWorker();
    syncCloudInBackground();
    warmupCriticalModules();
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 320);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('storage', (event) => {
  if (event.key === 'taskbox_data' || event.key === 'taskbox_points_cache') {
    if (event.key === 'taskbox_data') invalidateDataCache();
    route({ preserveScroll: true });
  }
});
window.addEventListener('DOMContentLoaded', async () => {
  getBoxes();
  setupAudioUnlock();
  setupKeyboardInsets();
  route();
  scheduleBackgroundWork();
});

window.TaskBoxApp = {
  navigate,
  openAIExtractSheet: async () => {
    if (!checkOnline()) return;
    const { openAIExtractSheet } = await import('./ai-extract.js');
    openAIExtractSheet();
  },
  showToast,
};
