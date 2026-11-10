/** Navigate away after a successful form submit when a https URL is set. */
export function formRedirectAfterSubmit(url: string | undefined): boolean {
  if (!url || !/^https:\/\//i.test(url)) return false;
  window.location.assign(url);
  return true;
}
