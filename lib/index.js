import { isAbsolute } from "node:path";
//#region src/config.ts
/** Documented defaults, used for absent input and for every invalid field. */
const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	dataDir: void 0,
	retentionDays: 30,
	retentionBytes: 104857600,
	maxOutputBytes: 32768,
	ignorePaths: Object.freeze([])
});
/**
* Read one field without ever propagating a throw. Host plugins are loaded with
* arbitrary user configuration, which may be an exotic object with an accessor
* that throws. `resolveConfig` is called outside the `apply` fail-open boundary,
* so totality has to be enforced here.
*/
const read = (source, key) => {
	try {
		return source[key];
	} catch {
		return;
	}
};
/** `Array.isArray` itself throws on a revoked proxy, so it is guarded too. */
const isArray = (value) => {
	try {
		return Array.isArray(value);
	} catch {
		return false;
	}
};
const isRecord = (value) => typeof value === "object" && value !== null && !isArray(value);
const isStringArray = (value) => isArray(value) && value.every((item) => typeof item === "string");
const readBoolean = (source, key, fallback) => {
	const value = read(source, key);
	return typeof value === "boolean" ? value : fallback;
};
const readPositiveInteger = (source, key, fallback) => {
	const value = read(source, key);
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const readAbsolutePath = (source, key, fallback) => {
	const value = read(source, key);
	return typeof value === "string" && isAbsolute(value) ? value : fallback;
};
const readStringArray = (source, key, fallback) => {
	const value = read(source, key);
	return isStringArray(value) ? Object.freeze([...value]) : fallback;
};
/**
* Turn arbitrary loader-supplied configuration into a valid {@link TurnscopeConfig}.
*
* Total by construction: unknown input and invalid fields fall back to their
* default individually, so one bad field never discards the valid ones.
*/
function resolveConfig(input) {
	const source = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: readBoolean(source, "enabled", DEFAULT_CONFIG.enabled),
		dataDir: readAbsolutePath(source, "dataDir", DEFAULT_CONFIG.dataDir),
		retentionDays: readPositiveInteger(source, "retentionDays", DEFAULT_CONFIG.retentionDays),
		retentionBytes: readPositiveInteger(source, "retentionBytes", DEFAULT_CONFIG.retentionBytes),
		maxOutputBytes: readPositiveInteger(source, "maxOutputBytes", DEFAULT_CONFIG.maxOutputBytes),
		ignorePaths: readStringArray(source, "ignorePaths", DEFAULT_CONFIG.ignorePaths)
	});
}
//#endregion
//#region src/index.ts
const name = "turnscope";
/**
* Host entry. Recording is best-effort: a failure here must never surface to
* the harness, so this function is a hard boundary and never throws.
*/
function apply(ctx, config) {
	if (!resolveConfig(config).enabled) return;
}
//#endregion
export { apply, name };
