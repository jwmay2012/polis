import { extractRedirectUrls } from '../utils';

export const redirect = (redirectUrl: string, redirectUrls: unknown): boolean => {
  if (typeof redirectUrl !== 'string' || redirectUrl === 'http://_boxyhq_redirect_not_in_use') {
    return false;
  }
  // Check raw syntax too: URL parsing erases empty fragments/userinfo and some controls.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f#]/.test(redirectUrl)) return false;
  try {
    const url = new URL(redirectUrl);
    const authority = redirectUrl.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] || '';
    if (
      /[@*]/.test(authority) ||
      url.username ||
      url.password ||
      url.hostname.includes('*') ||
      ((url.protocol === 'http:' || url.protocol === 'https:') && redirectUrl.includes('\\'))
    ) {
      return false;
    }
    const urls = extractRedirectUrls(redirectUrls as string[] | string);
    // Compare original strings, never parsed/normalized URL components or string substrings.
    return (
      Array.isArray(urls) && urls.every((value) => typeof value === 'string') && urls.includes(redirectUrl)
    );
  } catch {
    return false;
  }
};
