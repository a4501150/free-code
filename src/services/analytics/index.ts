/**
 * A string that the code has manually verified contains neither source code
 * nor filesystem paths and is therefore safe to send to analytics / logs.
 *
 * The verbose name is deliberate — it forces authors to think about what
 * they are tagging. Consumers treat it as a plain string; the type exists
 * as documentation / lint-bait, not as a runtime brand, which is why
 * raw `string` values assign to it freely (see e.g. fileOperationAnalytics.ts
 * where `createHash(...).digest('hex')` is returned directly).
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = string
