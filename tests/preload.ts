/**
 * `MACRO.*` is a build-time define (scripts/build.ts), so source-level tests
 * that reach code reading it would throw ReferenceError. Supply the same shape
 * with placeholder values.
 */
const globals = globalThis as { MACRO?: Record<string, string> }
globals.MACRO ??= {
  VERSION: '0.0.0-test',
  BUILD_TIME: '1970-01-01T00:00:00.000Z',
  PACKAGE_URL: 'free-code',
  FEEDBACK_CHANNEL: 'github',
  ISSUES_EXPLAINER: '',
  VERSION_CHANGELOG: '',
  GITHUB_REPO: '',
}
