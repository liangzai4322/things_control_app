import { exportDailyQuoteArchive, getDailyQuote, pullDailyQuoteFromCloud, saveDailyQuote } from './db.js';
import { showToast } from './app.js';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderDailyQuote({ editable = false } = {}) {
  const quote = getDailyQuote();
  return `
    <section class="daily-quote-strip ${editable ? 'editable' : ''}" data-daily-quote>
      <div class="daily-quote-copy">
        <span>每日一句</span>
        ${editable
          ? `<input id="dailyQuoteInput" class="daily-quote-input" value="${escapeHtml(quote.current)}" aria-label="每日一句">`
          : `<strong>${escapeHtml(quote.current)}</strong>`}
      </div>
      <button class="daily-quote-export" type="button" data-daily-quote-export aria-label="导出每日一句">导出</button>
    </section>
  `;
}

export function bindDailyQuote(root, { editable = false, onSaved } = {}) {
  root.querySelector('[data-daily-quote-export]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    exportDailyQuoteArchive();
  });

  if (!editable) return;

  const input = root.querySelector('#dailyQuoteInput');
  if (!input) return;

  const save = () => {
    const current = getDailyQuote().current;
    const next = input.value.trim();
    if (!next || next === current) {
      input.value = current;
      return;
    }
    saveDailyQuote(next);
    showToast('每日一句已保存');
    onSaved?.();
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
    if (event.key === 'Escape') {
      input.value = getDailyQuote().current;
      input.blur();
    }
  });
}

export async function refreshDailyQuote(root, { rerender } = {}) {
  const before = getDailyQuote().current;
  const after = await pullDailyQuoteFromCloud();
  if (after.current !== before) rerender?.();
  return after;
}
