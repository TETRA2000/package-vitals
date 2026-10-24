const REPO_FULL_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The Dependabot alert page. Throws unless the inputs are a GitHub repo name and an alert number, so a URL can't be steered elsewhere. */
export function dependabotAlertUrl(fullName: string, number: number): string {
  if (!REPO_FULL_NAME.test(fullName)) throw new Error('Not a GitHub repo name.');
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Not an alert number.');
  return `https://github.com/${fullName}/security/dependabot/${number}`;
}
