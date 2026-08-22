export interface MediaPermissionPreferences {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
}

export function isMediaAccessAllowed(
  preferences: MediaPermissionPreferences,
  mediaTypes: readonly string[],
): boolean {
  const allowUnknown = preferences.microphoneEnabled && preferences.cameraEnabled;
  if (mediaTypes.length === 0) return allowUnknown;

  return mediaTypes.every((mediaType) => {
    if (mediaType === "audio") return preferences.microphoneEnabled;
    if (mediaType === "video") return preferences.cameraEnabled;
    return allowUnknown;
  });
}
