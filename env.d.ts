declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL?: string
  NATIVE_PACKAGE_URL?: string
  FEEDBACK_CHANNEL?: string
  ISSUES_EXPLAINER?: string
  VERSION_CHANGELOG?: string
  GITHUB_REPO?: string
}

declare module '*.node' {
  const value: unknown
  export default value
}
