/** Hash navigation shared by the app's screens. */
export const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

/** Home has no hash at all, so the URL stays clean. */
export function goHome() {
  history.pushState(null, '', location.pathname + location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
