"use strict";

/**
 * Resolves the Android targetSdk the build will actually use. Shared by the
 * metadata target-API check and the permissions checks gated on target API.
 */

const path = require("path");
const { readText } = require("./parse");
const M = require("./data/metadata-maps");

const stripGradleComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function toSdkInt(v) {
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v)) ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readGradleTarget(root) {
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const src = readText(path.join(root, "android", "app", name));
    if (!src) continue;
    const m = stripGradleComments(src).match(/\btargetSdk(?:Version)?\s*(?:=\s*)?\(?\s*(\d+)/);
    if (m) return { value: parseInt(m[1], 10), source: `android/app/${name}` };
  }
  const props = readText(path.join(root, "android", "gradle.properties"));
  if (props) {
    const m = props.match(/^\s*android\.targetSdkVersion\s*=\s*(\d+)\s*$/m);
    if (m) return { value: parseInt(m[1], 10), source: "android/gradle.properties" };
  }
  const rootGradle = readText(path.join(root, "android", "build.gradle"));
  if (rootGradle) {
    const src = stripGradleComments(rootGradle);
    const m =
      src.match(/\btargetSdkVersion\s*=\s*(\d+)/) ||
      src.match(/findProperty\(\s*['"]android\.targetSdkVersion['"]\s*\)\s*\?:\s*['"](\d+)['"]/);
    if (m) return { value: parseInt(m[1], 10), source: "android/build.gradle" };
  }
  return null;
}

/**
 * Precedence mirrors the build: native gradle files, then expo-build-properties
 * (applied at prebuild), then the Expo / React Native default.
 * @returns {{effective:number|null, determined:boolean, gradle:object|null, pluginTarget:number|null, pluginInvalid:any, sourceName:string|null}}
 */
function resolveTargetSdk(ctx) {
  const gradle = readGradleTarget(ctx.detected.root);

  let pluginTarget = null;
  let pluginInvalid = null;
  const cfg = ctx.appConfig.config;
  if (cfg && Array.isArray(cfg.plugins)) {
    for (const p of cfg.plugins) {
      if (Array.isArray(p) && p[0] === "expo-build-properties" && p[1] && p[1].android && p[1].android.targetSdkVersion != null) {
        const v = p[1].android.targetSdkVersion;
        pluginTarget = toSdkInt(v);
        pluginInvalid = pluginTarget == null ? v : null;
      }
    }
  }

  let inferred = null;
  let inferredFrom = null;
  const expoMajor = ctx.detected.expoSdk ? parseInt(ctx.detected.expoSdk, 10) : NaN;
  if (Number.isInteger(expoMajor)) {
    inferred = M.expoToTargetSdk(expoMajor);
    inferredFrom = "Expo SDK " + ctx.detected.expoSdk;
  } else if (ctx.detected.rnVersion) {
    const [maj, min] = String(ctx.detected.rnVersion).split(".").map((n) => parseInt(n, 10));
    if (maj === 0 && Number.isInteger(min)) {
      inferred = M.rnToTargetSdk(min);
      inferredFrom = "React Native " + ctx.detected.rnVersion;
    }
  }

  return {
    effective: gradle ? gradle.value : pluginTarget != null ? pluginTarget : inferred,
    determined: !!gradle || pluginTarget != null,
    gradle,
    pluginTarget,
    pluginInvalid,
    sourceName: gradle ? gradle.source : pluginTarget != null ? "expo-build-properties" : inferredFrom,
  };
}

module.exports = { resolveTargetSdk };
