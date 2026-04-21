/**
 * Freedify Utils Module
 * Pure utility functions with no DOM or state dependencies
 */

export function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    seconds = Math.floor(seconds);
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

export function parseDuration(dur) {
    if (!dur) return 0;
    if (typeof dur === 'number') return dur;
    if (typeof dur === 'string' && !dur.includes(':')) return Number(dur) || 0;
    const parts = dur.toString().split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
}

export function getTimeSince(dateStr) {
    const now = new Date();
    const then = new Date(dateStr);
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return `${Math.floor(diffDay / 7)}w ago`;
}

export function showToast(message, duration = 3000) {
    let toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    Object.assign(toast.style, {
        position: 'fixed',
        bottom: '80px',
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: 'var(--accent)',
        color: 'white',
        padding: '10px 20px',
        borderRadius: '20px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: '10000',
        opacity: '0',
        transition: 'opacity 0.3s',
        pointerEvents: 'none'
    });
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.style.opacity = '1');

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * fetchWithRetry — resilient wrapper around fetch with exponential backoff.
 *
 * Retries on network errors and on retriable HTTP statuses (408, 429, 5xx),
 * honoring `Retry-After` when present.  Bails early if the caller's AbortSignal
 * is tripped.
 *
 * @param {string|Request} input
 * @param {RequestInit & {retries?:number,backoff?:number,retryOn?:(res:Response)=>boolean}} [init]
 */
export async function fetchWithRetry(input, init = {}) {
    const {
        retries = 3,
        backoff = 400,
        retryOn = (res) => [408, 425, 429, 500, 502, 503, 504].includes(res.status),
        ...rest
    } = init;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (rest.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
            const res = await fetch(input, rest);
            if (res.ok) return res;
            if (attempt >= retries || !retryOn(res)) return res;

            // Honor Retry-After if present
            let delay = backoff * Math.pow(2, attempt) + Math.random() * 200;
            const ra = res.headers.get('Retry-After');
            if (ra) {
                const raNum = Number(ra);
                if (Number.isFinite(raNum) && raNum > 0) delay = Math.max(delay, raNum * 1000);
            }
            await new Promise(r => setTimeout(r, delay));
        } catch (err) {
            lastErr = err;
            if (err?.name === 'AbortError') throw err;
            if (attempt >= retries) throw err;
            await new Promise(r => setTimeout(r, backoff * Math.pow(2, attempt) + Math.random() * 200));
        }
    }
    if (lastErr) throw lastErr;
    throw new Error('fetchWithRetry: exhausted retries');
}

/** Convenience: same as fetchWithRetry but also parses JSON. */
export async function fetchJsonWithRetry(input, init = {}) {
    const res = await fetchWithRetry(input, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    return res.json();
}

/**
 * Debounce helper — collapses bursts of calls into one.
 */
export function debounce(fn, wait = 200) {
    let t = null;
    return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
    };
}

/**
 * Throttle helper — guarantees at most one call every `wait` ms.
 */
export function throttle(fn, wait = 200) {
    let last = 0;
    let pending = null;
    return function (...args) {
        const now = Date.now();
        if (now - last >= wait) {
            last = now;
            fn.apply(this, args);
        } else {
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => {
                last = Date.now();
                pending = null;
                fn.apply(this, args);
            }, wait - (now - last));
        }
    };
}
