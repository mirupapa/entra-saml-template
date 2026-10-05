const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const root = escapeRegex(path.resolve(__dirname));
const generatedFiles = new RegExp(
  `^${root}[\\\\/](?:(?:dist|ios|android)[\\\\/]|\\.expo[\\\\/](?:dev[\\\\/]logs|prebuild)[\\\\/])`
);
const existing = config.resolver.blockList;
// Preserve Expo's defaults and keep generated files out of Metro's file map.
// In particular, Expo writes JSONL logs while the dev server is running.
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  generatedFiles,
];
module.exports = config;
