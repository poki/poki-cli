export const ANALYTICS_TIME_ZONE = 'Europe/Amsterdam'
export const RESOURCE_API_TIME_ZONE = 'UTC'

export const RESOURCE_API_TIME_ZONE_HELP = 'Timestamp fields returned by non-data API endpoints use UTC.'

export const analyticsTimeZone = {
  time_zone: ANALYTICS_TIME_ZONE,
  daylight_saving: 'CET (UTC+01:00) in winter and CEST (UTC+02:00) in summer.',
  applies_to: 'Date and DateTime values returned by POST /_data and supplied in analytics query filters.',
  interpretation: 'Treat unqualified analytics dates and timestamps as Europe/Amsterdam local time; do not interpret them as UTC.',
  contrast: RESOURCE_API_TIME_ZONE_HELP
} as const
