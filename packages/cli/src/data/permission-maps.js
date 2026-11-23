"use strict";

/**
 * Compliance knowledge, encoded as data — ported from agents/permissions-auditor.md,
 * rules/expo-rules.md and rules/android-guidelines.md §8.x. Keeping it declarative
 * makes each entry reviewable against the source guideline.
 */

/**
 * Expo / RN module → the iOS Info.plist usage strings it requires.
 * Missing a required string for an installed module = instant Apple 5.1.1 rejection.
 */
const MODULE_IOS_STRINGS = {
  "expo-camera": ["NSCameraUsageDescription"],
  "expo-image-picker": ["NSPhotoLibraryUsageDescription"],
  "expo-media-library": ["NSPhotoLibraryUsageDescription"],
  "expo-location": ["NSLocationWhenInUseUsageDescription"],
  "expo-contacts": ["NSContactsUsageDescription"],
  "expo-calendar": ["NSCalendarsUsageDescription"],
  "expo-av": ["NSMicrophoneUsageDescription"],
  "expo-audio": ["NSMicrophoneUsageDescription"],
  "expo-video": ["NSMicrophoneUsageDescription"],
  "expo-tracking-transparency": ["NSUserTrackingUsageDescription"],
  "expo-speech-recognition": ["NSSpeechRecognitionUsageDescription"],
  "expo-sensors": [],
  "@react-native-community/geolocation": ["NSLocationWhenInUseUsageDescription"],
  "react-native-vision-camera": ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"],
  "react-native-image-picker": ["NSPhotoLibraryUsageDescription", "NSCameraUsageDescription"],
};

/** Human label for each usage-string key, for clearer messages. */
const IOS_STRING_LABEL = {
  NSCameraUsageDescription: "camera",
  NSPhotoLibraryUsageDescription: "photo library",
  NSPhotoLibraryAddUsageDescription: "photo library (add only)",
  NSMicrophoneUsageDescription: "microphone",
  NSLocationWhenInUseUsageDescription: "location (when in use)",
  NSLocationAlwaysAndWhenInUseUsageDescription: "location (always)",
  NSContactsUsageDescription: "contacts",
  NSCalendarsUsageDescription: "calendar",
  NSRemindersUsageDescription: "reminders",
  NSUserTrackingUsageDescription: "tracking (ATT)",
  NSSpeechRecognitionUsageDescription: "speech recognition",
};

/**
 * Expo / RN module → Android permissions it auto-injects into the merged
 * manifest during prebuild (rules/expo-rules.md §C.5).
 */
const MODULE_ANDROID_PERMISSIONS = {
  "expo-camera": ["CAMERA", "RECORD_AUDIO"],
  "expo-location": ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"],
  "expo-image-picker": ["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO"],
  "expo-media-library": ["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "WRITE_EXTERNAL_STORAGE"],
  "expo-notifications": ["POST_NOTIFICATIONS"],
  "expo-contacts": ["READ_CONTACTS"],
};

/**
 * Android restricted permissions → the Play Console declaration required.
 * Declaring these without filing the declaration blocks the release.
 */
const RESTRICTED_ANDROID = {
  READ_SMS: "SMS/Call Log Permissions Declaration",
  SEND_SMS: "SMS/Call Log Permissions Declaration",
  RECEIVE_SMS: "SMS/Call Log Permissions Declaration",
  RECEIVE_MMS: "SMS/Call Log Permissions Declaration",
  READ_CALL_LOG: "SMS/Call Log Permissions Declaration",
  WRITE_CALL_LOG: "SMS/Call Log Permissions Declaration",
  PROCESS_OUTGOING_CALLS: "SMS/Call Log Permissions Declaration",
  MANAGE_EXTERNAL_STORAGE: "All Files Access Declaration",
  ACCESS_BACKGROUND_LOCATION: "Background Location Declaration",
  QUERY_ALL_PACKAGES: "Package Visibility Declaration",
  BIND_ACCESSIBILITY_SERVICE: "Accessibility Declaration",
  PACKAGE_USAGE_STATS: "Sensitive permission justification",
  REQUEST_INSTALL_PACKAGES: "Unknown sources / install-packages justification",
  BIND_VPN_SERVICE: "VPN Service Policy compliance",
  READ_HEALTH_DATA: "Health Apps Declaration + Verified Org Account",
};

/**
 * Permissions with a dated Play policy change (Oct 29, 2026 announcement,
 * rules/android-guidelines.md §8.1, §8.2a, §8.12, §8.19). Default severity is
 * INFO before the deadline and MEDIUM after; with minTarget, it is MEDIUM only
 * once the app targets that API level (INFO while the target is unknown).
 */
const DATED_ANDROID_POLICIES = {
  ACCESS_FINE_LOCATION: {
    deadline: "2027-01-27",
    policy: "Location Permissions",
    detail: "Play requires a declaration justifying why coarse location or the Android location button isn't enough.",
    fix: "Use ACCESS_COARSE_LOCATION if city-level accuracy is enough (Expo: add ACCESS_FINE_LOCATION to android.blockedPermissions). Otherwise file the location declaration in Play Console.",
  },
  READ_CONTACTS: {
    deadline: "2027-01-27",
    minTarget: 37,
    policy: "Contacts Permissions",
    detail: "Apps targeting API 37+ may only request it if the Android Contact Picker isn't sufficient, and must file a declaration.",
    fix: "Switch to the Android Contact Picker and remove READ_CONTACTS, or prepare the contacts declaration before targeting API 37.",
  },
  READ_CALL_LOG: {
    deadline: "2027-01-27",
    policy: "SMS and Call Log Permissions",
    detail: "Account verification via phone call (missed-call / flash-call OTP) is no longer a permitted use.",
    fix: "Remove READ_CALL_LOG and verify phone numbers with the SMS Retriever API, the SMS User Consent API, or the Digital Credentials API.",
    // Only the phone-call verification use ends; other call-log uses are covered
    // by the restricted-permission check, so this fires only with this evidence.
    requiresSource: /flash[_-]?call|missed[_-]?call|truecaller[\s\S]{0,40}verif/i,
    severity: { before: "HIGH", after: "BLOCKER" },
  },
  ACCESS_LOCAL_NETWORK: {
    deadline: "2027-08-25",
    minTarget: 37,
    policy: "Local Network Permission",
    detail: "Apps targeting API 37+ may only request it for core functionality when device pickers such as NsdManager aren't sufficient, and must file a declaration.",
    fix: "Use NsdManager or a device picker for single-device discovery; file the Local Network declaration only if broad LAN access is core.",
  },
  MANAGE_CONTACTS: {
    deadline: "2027-08-25",
    minTarget: 38,
    policy: "Manage Contacts Permission",
    detail: "Restricted to apps whose core function needs contact management where the ACTION_INSERT / ACTION_EDIT intents aren't enough; declaration required.",
    fix: "Add or edit contacts through Intent.ACTION_INSERT / Intent.ACTION_EDIT and remove MANAGE_CONTACTS.",
  },
};

/** Photo-library media permissions governed by Android §8.4. */
const MEDIA_PERMISSIONS = ["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_VISUAL_USER_SELECTED"];

/**
 * Source patterns used to decide the §8.4 BLOCKER-vs-HIGH heuristic.
 * One-off picker usage → permission not needed → BLOCKER if still declared.
 * Library enumeration / full gallery → may justify it → HIGH (needs Declaration).
 */
const PICKER_USAGE_RE = /launchImageLibraryAsync|PickVisualMedia|ACTION_PICK_IMAGES|ImagePicker\.|launchImageLibrary\(/;
const GALLERY_ENUMERATION_RE = /MediaStore\.Images\.Media|getAssetsAsync|MediaLibrary\.getAssets|cursor\.moveToNext|ContentResolver/;

/** Words that make an iOS usage string specific rather than boilerplate. */
const SPECIFIC_PURPOSE_RE = /\b(when you|for example|such as|so you can|to let you|in order to|so that)\b/i;

module.exports = {
  MODULE_IOS_STRINGS,
  IOS_STRING_LABEL,
  MODULE_ANDROID_PERMISSIONS,
  RESTRICTED_ANDROID,
  DATED_ANDROID_POLICIES,
  MEDIA_PERMISSIONS,
  PICKER_USAGE_RE,
  GALLERY_ENUMERATION_RE,
  SPECIFIC_PURPOSE_RE,
};
