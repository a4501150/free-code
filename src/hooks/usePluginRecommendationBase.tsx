import type { useNotifications } from '../context/notifications.js'
import { getPluginById } from '../utils/plugins/marketplaceManager.js'

type AddNotification = ReturnType<typeof useNotifications>['addNotification']
type PluginData = NonNullable<Awaited<ReturnType<typeof getPluginById>>>
