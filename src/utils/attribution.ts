import { PRODUCT_URL } from '../constants/product.js'
import {
  getDefaultMainLoopModelSetting,
  getMainLoopModel,
  getPublicModelDisplayName,
  getPublicModelName,
} from './model/model.js'
import { getInitialSettings } from './settings/settings.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

export function getAttributionTexts(): AttributionTexts {
  const model = getMainLoopModel()
  const isKnownPublicModel = getPublicModelDisplayName(model) !== null
  const modelName = isKnownPublicModel
    ? getPublicModelName(model)
    : getPublicModelName(getDefaultMainLoopModelSetting())
  const settings = getInitialSettings()

  const email = settings.attribution?.email ?? 'noreply@anthropic.com'
  const defaultAttribution = `🤖 Generated with [Claude Code](${PRODUCT_URL})`
  const defaultCommit = `Co-Authored-By: ${modelName} <${email}>`

  if (settings.attribution) {
    return {
      commit: settings.attribution.commit ?? defaultCommit,
      pr: settings.attribution.pr ?? defaultAttribution,
    }
  }

  if (settings.includeCoAuthoredBy === false) {
    return { commit: '', pr: '' }
  }

  return { commit: defaultCommit, pr: defaultAttribution }
}
