"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { scan, computeScore } = require("../src/scan");
const { isGeneric } = require("../src/rules/permissions");
const { renderTerminal } = require("../src/report-terminal");
const { buildReport } = require("../src/report-html");

let tmpRoot;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
});
test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

/** Write a map of relative path -> contents into a fresh project dir. */
function makeProject(name, files) {
  const dir = path.join(tmpRoot, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const has = (result, sev, titleSubstr) =>
  result.issues.some((i) => i.severity === sev && i.title.includes(titleSubstr));

// ── §8.4 flagship BLOCKER ───────────────────────────────────────────────────────
test("expo one-off picker with media perm not blocked → §8.4 BLOCKER", () => {
  const dir = makeProject("biodata-bad", {
    "package.json": { name: "biodata", dependencies: { expo: "54.0.0", "expo-image-picker": "17.0.0" } },
    "app.json": { expo: { name: "Biodata", ios: { infoPlist: {} }, android: {} } },
    "App.tsx": `import * as ImagePicker from 'expo-image-picker';
export async function pick(){ return ImagePicker.launchImageLibraryAsync(); }`,
  });
  const r = scan(dir);
  assert.ok(has(r, "BLOCKER", "Photo/video permission declared for one-off access"), "expected §8.4 blocker");
  assert.ok(has(r, "BLOCKER", "Missing photo library usage string"), "expected missing iOS string blocker");
  assert.strictEqual(r.ready, false);
  assert.ok(r.score < 60, "score should drop with two blockers, got " + r.score);
});

// ── Fixed version → ready ─────────────────────────────────────────────────────
test("blocked media perm + specific iOS string → READY, no blockers", () => {
  const dir = makeProject("biodata-good", {
    "package.json": { name: "biodata", dependencies: { expo: "54.0.0", "expo-image-picker": "17.0.0" } },
    "app.json": {
      expo: {
        name: "Biodata",
        ios: {
          infoPlist: {
            NSPhotoLibraryUsageDescription: "Used so you can attach a profile photo to your biodata.",
          },
        },
        android: { blockedPermissions: ["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO"] },
      },
    },
    "App.tsx": `import * as ImagePicker from 'expo-image-picker';
export const pick = () => ImagePicker.launchImageLibraryAsync();`,
  });
  const r = scan(dir, { category: "permissions" });
  assert.strictEqual(r.counts.BLOCKER, 0, "should have no blockers: " + JSON.stringify(r.issues));
  assert.strictEqual(r.ready, true);
  assert.ok(r.passed.some((p) => /photo library usage string/i.test(p)));
  assert.ok(r.passed.some((p) => /No broad photo\/video permission/.test(p)));
});

// ── Generic usage string → HIGH ─────────────────────────────────────────────────
test("generic iOS usage string → HIGH", () => {
  const dir = makeProject("generic-string", {
    "package.json": { name: "cam", dependencies: { expo: "54.0.0", "expo-camera": "16.0.0" } },
    "app.json": {
      expo: { name: "Cam", ios: { infoPlist: { NSCameraUsageDescription: "We need camera access" } }, android: { blockedPermissions: [] } },
    },
    "App.tsx": `import { CameraView } from 'expo-camera';`,
  });
  const r = scan(dir);
  assert.ok(has(r, "HIGH", "Generic camera usage string"), JSON.stringify(r.issues, null, 2));
});

// ── Native Android: FGS without type + restricted SMS ──────────────────────────
test("native manifest: foreground service without type → BLOCKER; READ_SMS → HIGH", () => {
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.READ_SMS" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <application>
    <service android:name=".SyncService" android:exported="false" />
  </application>
</manifest>`;
  const dir = makeProject("native-android", {
    "package.json": { name: "rn", dependencies: { "react-native": "0.81.0" } },
    "android/app/src/main/AndroidManifest.xml": manifest,
  });
  const r = scan(dir);
  assert.ok(has(r, "BLOCKER", "foregroundServiceType"), "expected FGS blocker: " + JSON.stringify(r.issues));
  assert.ok(has(r, "HIGH", "Restricted permission READ_SMS"), "expected SMS declaration HIGH");
  // Line numbers should be populated from the manifest.
  const sms = r.issues.find((i) => i.title.includes("READ_SMS"));
  assert.strictEqual(sms.line, 3, "SMS perm should be on line 3");
});

// ── Over-declared storage → MEDIUM ──────────────────────────────────────────────
test("legacy WRITE_EXTERNAL_STORAGE → MEDIUM", () => {
  const dir = makeProject("legacy-storage", {
    "package.json": { name: "rn", dependencies: { expo: "54.0.0" } },
    "app.json": { expo: { name: "X", android: { permissions: ["android.permission.WRITE_EXTERNAL_STORAGE"] } } },
  });
  const r = scan(dir);
  assert.ok(has(r, "MEDIUM", "WRITE_EXTERNAL_STORAGE"), JSON.stringify(r.issues));
});

// ── Flutter / unknown handling ──────────────────────────────────────────────────
test("flutter project → INFO not-supported note, exit-clean", () => {
  const dir = makeProject("flutter", { "pubspec.yaml": "name: myapp\n" });
  const r = scan(dir);
  assert.strictEqual(r.kind, "flutter");
  assert.strictEqual(r.counts.BLOCKER, 0);
  assert.ok(r.issues.some((i) => i.severity === "INFO" && /Flutter/.test(i.title)));
});

// ── Unit: scoring + generic detection + renderers don't throw ──────────────────
test("computeScore weights blockers heaviest", () => {
  assert.strictEqual(computeScore({ BLOCKER: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }), 100);
  assert.strictEqual(computeScore({ BLOCKER: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }), 75);
  assert.strictEqual(computeScore({ BLOCKER: 5, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }), 0);
  assert.strictEqual(computeScore({ BLOCKER: 0, HIGH: 2, MEDIUM: 1, LOW: 0, INFO: 9 }), 76);
});

test("isGeneric flags short/vague, accepts specific", () => {
  assert.strictEqual(isGeneric("We need camera access"), true);
  assert.strictEqual(isGeneric("Used"), true);
  assert.strictEqual(isGeneric("Used so you can attach a photo to your biodata profile."), false);
});

test("renderers produce output without throwing", () => {
  const dir = makeProject("render", {
    "package.json": { name: "r", dependencies: { expo: "54.0.0", "expo-image-picker": "17.0.0" } },
    "app.json": { expo: { name: "R", ios: { infoPlist: {} }, android: {} } },
    "App.tsx": "ImagePicker.launchImageLibraryAsync()",
  });
  const r = scan(dir);
  const term = renderTerminal(r);
  assert.match(term, /Review Ready/);
  assert.match(term, /score/);
  const html = buildReport(r);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /Score/);
});

// ── Dated Play policies (Oct 29, 2026 announcement) ─────────────────────────────
function datedProject(name, perms, extra = {}) {
  return makeProject(name, {
    "package.json": { name, dependencies: { expo: "54.0.0" } },
    "app.json": { expo: { name, android: { permissions: perms } } },
    ...extra,
  });
}
const dated = (r) => r.issues.filter((i) => /policy applies (from|since)/.test(i.title));
const datedFor = (r, perm) => dated(r).find((i) => i.title.startsWith(perm + ":"));

test("fine location before Jan 27, 2027 → INFO with the deadline", () => {
  const i = datedFor(scan(datedProject("loc-before", ["ACCESS_FINE_LOCATION"]), { now: "2027-01-26" }), "ACCESS_FINE_LOCATION");
  assert.strictEqual(i.severity, "INFO");
  assert.match(i.title, /applies from 2027-01-27/);
});

test("fine location on the deadline (local calendar day) → MEDIUM", () => {
  const dir = datedProject("loc-after", ["android.permission.ACCESS_FINE_LOCATION"]);
  for (const now of ["2027-01-27", new Date(2027, 0, 27, 0, 30), new Date(2027, 0, 27, 23, 30)]) {
    const i = datedFor(scan(dir, { now }), "ACCESS_FINE_LOCATION");
    assert.strictEqual(i.severity, "MEDIUM", String(now));
    assert.match(i.title, /applies since 2027-01-27/);
  }
  assert.strictEqual(datedFor(scan(dir, { now: new Date(2027, 0, 26, 23, 59) }), "ACCESS_FINE_LOCATION").severity, "INFO");
});

test("target-gated rules: INFO below the target, MEDIUM once the app targets it", () => {
  const perms = ["READ_CONTACTS", "ACCESS_LOCAL_NETWORK", "MANAGE_CONTACTS"];
  const low = scan(datedProject("gated-36", perms), { now: "2028-01-01" });
  for (const p of perms) assert.strictEqual(datedFor(low, p).severity, "INFO", p);
  assert.match(datedFor(low, "MANAGE_CONTACTS").title, /API 38\+/);

  const high = scan(datedProject("gated-37", perms, { "android/app/build.gradle": "android { defaultConfig { targetSdkVersion 37 } }" }), { now: "2028-01-01" });
  assert.strictEqual(datedFor(high, "READ_CONTACTS").severity, "MEDIUM");
  assert.strictEqual(datedFor(high, "ACCESS_LOCAL_NETWORK").severity, "MEDIUM");
  assert.strictEqual(datedFor(high, "MANAGE_CONTACTS").severity, "INFO", "API 37 < 38");

  const early = scan(datedProject("gated-37-early", perms, { "android/app/build.gradle": "android { defaultConfig { targetSdkVersion 37 } }" }), { now: "2026-11-23" });
  assert.strictEqual(datedFor(early, "READ_CONTACTS").severity, "INFO", "before the deadline");
});

test("READ_CALL_LOG: dated finding only with phone-call verification evidence; HIGH then BLOCKER", () => {
  const plain = datedProject("calllog-plain", ["READ_CALL_LOG"]);
  assert.strictEqual(datedFor(scan(plain, { now: "2027-02-01" }), "READ_CALL_LOG"), undefined);

  const otp = datedProject("calllog-otp", ["READ_CALL_LOG"], { "Verify.tsx": "export const verifyByMissedCall = () => startFlashCall();" });
  assert.strictEqual(datedFor(scan(otp, { now: "2027-01-26" }), "READ_CALL_LOG").severity, "HIGH");
  const after = scan(otp, { now: "2027-01-27" });
  assert.strictEqual(datedFor(after, "READ_CALL_LOG").severity, "BLOCKER");
  assert.strictEqual(after.ready, false);
});

test("blocked or absent permissions produce no dated finding", () => {
  const dir = makeProject("loc-blocked", {
    "package.json": { name: "x", dependencies: { expo: "54.0.0", "expo-location": "19.0.0" } },
    "app.json": { expo: { name: "x", android: { blockedPermissions: ["android.permission.ACCESS_FINE_LOCATION"] } } },
  });
  const r = scan(dir, { now: "2027-06-01" });
  assert.strictEqual(datedFor(r, "ACCESS_FINE_LOCATION"), undefined);
  assert.strictEqual(dated(scan(datedProject("none", []), { now: "2027-06-01" })).length, 0);
});

test("invalid `now` is rejected; scannedAt follows a pinned date", () => {
  const dir = datedProject("now-check", ["ACCESS_FINE_LOCATION"]);
  for (const bad of ["not-a-date", "2027-02-30", "2027-13-01"]) {
    assert.throws(() => scan(dir, { now: bad }), /invalid "now"/, bad);
  }
  const r = scan(dir, { now: "2027-01-27" });
  assert.strictEqual(new Date(r.scannedAt).getTime(), new Date(2027, 0, 27).getTime());
});
