/**
 * Euclidean rhythm: k hits spread as evenly as possible over n steps
 * (Bresenham), first hit on step 0, then rotated right by `rot` steps.
 */
export function euclid(k, n, rot = 0) {
  k = Math.max(0, Math.min(n, k | 0));
  const base = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    base[i] = Math.floor((i * k) / n) !== Math.floor(((i - 1 + n) % n * k) / n) || (i === 0 && k > 0) ? 1 : 0;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[(i + rot) % n] = base[i];
  return out;
}
